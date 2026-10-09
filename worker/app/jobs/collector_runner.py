"""ROBÔ 2 — Collector: consulta agendamentos `waiting_sefaz` e baixa os ZIPs processados."""

from __future__ import annotations

import asyncio

from datetime import timedelta

from app.automation.base import AutomationContext
from app.jobs.base_runner import BaseRunner, now_utc
from app.jobs.collect import (  # noqa: F401 - reexportados (testes e chamadores antigos)
    DOWNLOAD_BACKOFF_MINUTES,
    DOWNLOAD_MAX_FAILURES,
    DOWNLOAD_SOFT_ERRORS,
    FINAL_TASK_STATUSES,
    KEY_CHECK_MINUTES,
    ExportCollection,
)
from app.jobs.errors import AutomationError, ErrorCode, JobCancelled
from app.jobs.models import Job, TaskStatus
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger


class CollectorRunner(ExportCollection, BaseRunner):
    phase = "collect"

    async def run_once(self) -> bool:
        job = await self.repo.claim_next_collection(self.deps.worker_id)
        if job is None:
            return False
        with self.deps.activity.job(job.id):
            await self.process(job)
        return True



    async def process(self, job: Job) -> None:
        logger = JobLogger(self.repo, job.id)
        ctx: AutomationContext | None = None
        reporter = JobReporter(
            self.repo,
            job,
            self.settings,
            logger,
            phase=self.phase,
            initial=JobStatus.CHECKING_PROCESSING,
            page_getter=lambda: ctx.page if ctx else None,
        )
        await logger.info(f"Collector: consulta nº {job.check_count} dos agendamentos.", step="checking_processing")
        try:
            all_tasks = await self.repo.list_tasks(job.id)
            pending = [
                t
                for t in all_tasks
                if t.is_export and not t.superseded and t.status in (TaskStatus.SCHEDULED, TaskStatus.PROCESSED)
            ]
            if not pending:
                await self._conclude(job, reporter, all_tasks, logger)
                return

            client, certificate = await self.load_client_and_certificate(job)
            await self.deps.certificate_manager.ensure_ready(client, certificate)
            provider = self.deps.registry.get(job.provider)
            ctx = self.build_context(job, client, certificate, reporter, logger)

            async with provider.open_session(ctx):
                await provider.login(ctx)
                await provider.select_company(ctx)
                await reporter.step(JobStatus.CHECKING_PROCESSING, "Consultando agendamentos na SEFAZ")
                statuses = await provider.check_status(ctx, pending)
                await self._record_check(job, statuses)
                retry_minutes = await self._apply_statuses(job, ctx, provider, reporter, logger, pending, statuses)

            refreshed = await self.repo.list_tasks(job.id)
            await self._conclude(job, reporter, refreshed, logger, retry_in=min(retry_minutes) if retry_minutes else None)

        except asyncio.CancelledError:
            # worker interrompido: volta a aguardar a SEFAZ para nova consulta
            await self.repo.update_job(
                job.id,
                status=JobStatus.WAITING_SEFAZ.value,
                current_step=JobStatus.WAITING_SEFAZ.value,
                progress=80,
                next_check_at=now_utc(),
                last_message="Worker interrompido; consulta reagendada.",
            )
            raise
        except JobCancelled:
            await self.repo.update_job(
                job.id,
                status=JobStatus.CANCELLED.value,
                current_step=JobStatus.CANCELLED.value,
                finished_at=now_utc(),
                last_message="Cancelado pelo usuário",
            )
        except Exception as exc:  # noqa: BLE001
            await self._failed(job, reporter, logger, ctx, exc)
        finally:
            await self.repo.release_lock(job.id, self.deps.worker_id)

    async def _failed(
        self, job: Job, reporter: JobReporter, logger: JobLogger, ctx: AutomationContext | None, exc: BaseException
    ) -> None:
        if await self.hand_over(job, logger, exc, collect=True):
            return
        code, message = self.describe(exc)
        screenshot = await self.error_screenshot(ctx, job, logger)
        await logger.error(f"[{code}] {message}", step=reporter.state.value, metadata={"error_code": code.value})
        retryable = not isinstance(exc, AutomationError) or exc.retryable
        if retryable and job.check_count < await self._max_checks():
            # erros transitórios: volta a aguardar e tenta de novo mais tarde, sem martelar o SIAT
            # (5 min; 15 min se a consulta anterior também falhou)
            wait = 15 if job.error_code else 5
            await self.repo.update_job(
                job.id,
                status=JobStatus.WAITING_SEFAZ.value,
                current_step=JobStatus.WAITING_SEFAZ.value,
                progress=80,
                next_check_at=now_utc() + timedelta(minutes=wait),
                error_code=code.value,
                error_message=message,
                error_screenshot_path=screenshot,
                last_message=f"Erro na consulta: {message}. Nova consulta agendada.",
            )
            return
        status = JobStatus.CERTIFICATE_REQUIRED if code in (
            ErrorCode.CERTIFICATE_REQUIRED, ErrorCode.CERTIFICATE_EXPIRED
        ) else JobStatus.FAILED
        await self.repo.update_job(
            job.id,
            status=status.value,
            current_step=status.value,
            error_code=code.value,
            error_message=message,
            error_screenshot_path=screenshot,
            finished_at=now_utc(),
            last_message=f"Erro: {message}",
        )
