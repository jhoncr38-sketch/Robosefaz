"""ROBÔ 2 — Collector: consulta agendamentos `waiting_sefaz` e baixa os ZIPs processados."""

from __future__ import annotations

import asyncio

from datetime import timedelta

from app.automation.base import AutomationContext
from app.jobs.base_runner import BaseRunner, now_utc
from app.jobs.errors import AutomationError, ErrorCode, JobCancelled
from app.jobs.models import ExportStatus, Job, Task, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger

FINAL_TASK_STATUSES = frozenset(
    {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.SKIPPED, TaskStatus.CANCELLED, TaskStatus.DRY_RUN}
)


class CollectorRunner(BaseRunner):
    phase = "collect"

    async def run_once(self) -> bool:
        job = await self.repo.claim_next_collection(self.deps.worker_id)
        if job is None:
            return False
        await self.process(job)
        return True

    async def _interval_minutes(self) -> int:
        return int(await self.repo.get_setting("collector_interval_minutes", self.settings.collector_interval_minutes))

    async def _max_checks(self) -> int:
        return int(await self.repo.get_setting("collector_max_checks", self.settings.collector_max_checks))

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

                for task, st in zip(pending, statuses, strict=True):
                    await reporter.check_cancel()
                    if st.status == ExportStatus.PROCESSED:
                        await self.repo.update_task(task.id, status=TaskStatus.PROCESSED.value)
                        await reporter.step(JobStatus.DOWNLOAD_AVAILABLE, f"{task.document_type} processado")
                        download_task = await self.repo.create_task(
                            job_id=job.id,
                            client_id=job.client_id,
                            task_type=TaskType.DOWNLOAD,
                            competence=job.competence,
                            status=TaskStatus.RUNNING,
                            document_type=task.document_type,
                            result={"export_task_id": task.id},
                        )
                        try:
                            stored = await provider.download(ctx, task, st)
                        except AutomationError as exc:
                            await self.repo.update_task(
                                download_task.id,
                                status=TaskStatus.FAILED.value,
                                error_message=exc.message,
                                finished_at=now_utc(),
                            )
                            raise
                        await self.repo.insert_download(
                            client_id=job.client_id,
                            job_id=job.id,
                            automation_task_id=download_task.id,
                            document_type=stored.document_type.value,
                            competence=job.competence,
                            filename=stored.filename,
                            filepath=stored.filepath,
                            size=stored.size,
                            checksum=stored.checksum,
                            downloaded_at=now_utc(),
                        )
                        await self.repo.update_task(
                            download_task.id,
                            status=TaskStatus.COMPLETED.value,
                            finished_at=now_utc(),
                            result={"export_task_id": task.id, **stored.model_dump(mode="json")},
                        )
                        await self.repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc())
                        task.status = TaskStatus.COMPLETED
                    elif st.status == ExportStatus.ERROR:
                        await self.repo.update_task(
                            task.id,
                            status=TaskStatus.FAILED.value,
                            error_message=f"SEFAZ retornou erro no processamento: {st.raw_status or ''}"[:500],
                            finished_at=now_utc(),
                        )
                        task.status = TaskStatus.FAILED
                        await logger.error(f"{task.task_type}: SEFAZ retornou erro.", step="checking_processing")
                    elif st.status == ExportStatus.NOT_FOUND:
                        await logger.warning(
                            f"{task.task_type}: agendamento não localizado na lista do portal.",
                            step="checking_processing",
                        )
                    else:
                        await logger.info(f"{task.task_type}: ainda em processamento.", step="checking_processing")

            refreshed = await self.repo.list_tasks(job.id)
            await self._conclude(job, reporter, refreshed, logger)

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

    async def _record_check(self, job: Job, statuses) -> None:  # noqa: ANN001
        summary = [s.model_dump(mode="json") for s in statuses]
        await self.repo.create_task(
            job_id=job.id,
            client_id=job.client_id,
            task_type=TaskType.CHECK_PROCESSING,
            competence=job.competence,
            status=TaskStatus.COMPLETED,
            result={"check": job.check_count, "statuses": summary},
        )

    async def _conclude(self, job: Job, reporter: JobReporter, tasks: list[Task], logger: JobLogger) -> None:
        exports = [t for t in tasks if t.is_export and not t.superseded]
        if exports and all(t.status in FINAL_TASK_STATUSES for t in exports):
            if any(t.status == TaskStatus.COMPLETED for t in exports):
                failed = [t for t in exports if t.status == TaskStatus.FAILED]
                msg = "Concluído" if not failed else f"Concluído com {len(failed)} exportação(ões) com erro"
                await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=msg)
                await logger.info(msg, step="completed")
            else:
                await reporter.set_final(
                    JobStatus.FAILED,
                    finished_at=now_utc(),
                    error_code=ErrorCode.EXPORT_FAILED.value,
                    error_message="Nenhuma exportação foi concluída.",
                    last_message="Nenhuma exportação foi concluída.",
                )
            return

        max_checks = await self._max_checks()
        if job.check_count >= max_checks:
            await reporter.set_final(
                JobStatus.FAILED,
                finished_at=now_utc(),
                error_code=ErrorCode.COLLECTOR_EXHAUSTED.value,
                error_message=f"Arquivos não disponibilizados após {max_checks} consultas.",
                last_message="Limite de consultas atingido",
            )
            return

        interval = await self._interval_minutes()
        await reporter.set_final(
            JobStatus.WAITING_SEFAZ,
            next_check_at=now_utc() + timedelta(minutes=interval),
            last_message=f"Aguardando processamento SEFAZ (próxima consulta em {interval} min)",
        )

    async def _failed(
        self, job: Job, reporter: JobReporter, logger: JobLogger, ctx: AutomationContext | None, exc: BaseException
    ) -> None:
        code, message = self.describe(exc)
        screenshot = await self.error_screenshot(ctx, job, logger)
        await logger.error(f"[{code}] {message}", step=reporter.state.value, metadata={"error_code": code.value})
        retryable = not isinstance(exc, AutomationError) or exc.retryable
        if retryable and job.check_count < await self._max_checks():
            # erros transitórios: volta a aguardar e tenta de novo mais tarde
            delay = self.deps.retry_policy.delay_for(min(max(job.check_count, 1), len(self.deps.retry_policy.delays)))
            await self.repo.update_job(
                job.id,
                status=JobStatus.WAITING_SEFAZ.value,
                current_step=JobStatus.WAITING_SEFAZ.value,
                progress=80,
                next_check_at=now_utc() + timedelta(seconds=max(delay, 60)),
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
