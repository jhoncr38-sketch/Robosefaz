"""ROBÔ 1 — Scheduler: cria os agendamentos de exportação no portal.

Após agendar, o job vai para `waiting_sefaz` e o navegador é FECHADO;
o Collector retoma depois.
"""

from __future__ import annotations

import asyncio

from datetime import timedelta

from app.automation.base import AutomationContext
from app.jobs.base_runner import BaseRunner, now_utc
from app.jobs.dedup import DuplicateGuard
from app.jobs.errors import AutomationError, ErrorCode, JobCancelled
from app.jobs.models import EXPORT_TASK_TYPES, Job, Task, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger

TASK_STEP: dict[TaskType, JobStatus] = {
    TaskType.NFCE_EXPORT: JobStatus.SCHEDULING_NFCE,
    TaskType.NFE_ISSUED_EXPORT: JobStatus.SCHEDULING_NFE_ISSUED,
    TaskType.NFE_RECEIVED_EXPORT: JobStatus.SCHEDULING_NFE_RECEIVED,
}

# Ordem fixa das operações (NFC-e -> NF-e emitidas -> NF-e recebidas)
TASK_ORDER = {t: i for i, t in enumerate(EXPORT_TASK_TYPES)}


class SchedulerRunner(BaseRunner):
    phase = "schedule"

    async def run_once(self) -> bool:
        job = await self.repo.claim_next_job(self.deps.worker_id)
        if job is None:
            return False
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
            initial=JobStatus.STARTING,
            page_getter=lambda: ctx.page if ctx else None,
        )
        await logger.info(
            f"Job iniciado (tentativa {job.attempts}) por {self.deps.worker_id}. "
            f"Dry-run: {'sim' if self.settings.automation_dry_run else 'não'}.",
            step="starting",
        )
        tasks: list[Task] = []
        try:
            client, certificate = await self.load_client_and_certificate(job)
            check = await self.deps.certificate_manager.ensure_ready(client, certificate)
            for w in check.warnings:
                await logger.warning(w, step="starting")

            all_tasks = await self.repo.list_tasks(job.id)
            tasks = sorted(
                [
                    t
                    for t in all_tasks
                    if t.is_export and not t.superseded and t.status in (TaskStatus.PENDING, TaskStatus.RUNNING)
                ],
                key=lambda t: TASK_ORDER[t.task_type],
            )
            if not tasks:
                await self._finish_without_work(job, reporter, all_tasks)
                return

            provider = self.deps.registry.get(job.provider)
            ctx = self.build_context(job, client, certificate, reporter, logger)
            guard = DuplicateGuard(self.repo)

            async with provider.open_session(ctx):
                await provider.login(ctx)
                await provider.select_company(ctx)
                for task in tasks:
                    await reporter.check_cancel()
                    duplicate = await guard.already_scheduled(task, force=job.force_reschedule)
                    if duplicate is not None:
                        await self.repo.update_task(
                            task.id,
                            status=TaskStatus.SKIPPED.value,
                            error_message="Exportação já agendada.",
                            finished_at=now_utc(),
                            result={"duplicate_of": duplicate.id},
                        )
                        task.status = TaskStatus.SKIPPED
                        await logger.warning(
                            f"{task.task_type}: Exportação já agendada (tarefa {duplicate.id}).",
                            step="dedup",
                        )
                        continue

                    await reporter.step(TASK_STEP[task.task_type])
                    await self.repo.update_task(task.id, status=TaskStatus.RUNNING.value, started_at=now_utc())
                    ctx.on_submit = self._submit_marker(task, logger)
                    result = await provider.schedule(ctx, task)
                    ctx.on_submit = None
                    new_status = TaskStatus.DRY_RUN if result.dry_run else TaskStatus.SCHEDULED
                    await self.repo.update_task(
                        task.id,
                        status=new_status.value,
                        external_request_id=result.external_request_id,
                        requested_at=result.requested_at,
                        finished_at=now_utc() if result.dry_run else None,
                        result=result.model_dump(mode="json"),
                    )
                    task.status = new_status
                    await logger.info(
                        f"{task.task_type}: {'simulado (dry-run)' if result.dry_run else 'agendado'}"
                        f"{' - protocolo ' + result.external_request_id if result.external_request_id else ''}.",
                        step=TASK_STEP[task.task_type].value,
                    )

            await self._finish_after_scheduling(job, reporter, tasks, logger)

        except asyncio.CancelledError:
            # worker interrompido (2º Ctrl+C): devolve o job à fila sem contar tentativa
            await self._requeue_after_interrupt(job, tasks)
            raise
        except JobCancelled:
            await self._cancelled(job, reporter, tasks, logger)
        except Exception as exc:  # noqa: BLE001 - tratado e registrado
            await self._failed(job, reporter, tasks, logger, ctx, exc)
        finally:
            await self.repo.release_lock(job.id, self.deps.worker_id)

    def _submit_marker(self, task: Task, logger: JobLogger):  # noqa: ANN202
        """Marca a tarefa como agendada no banco ANTES do clique final.

        Se algo falhar depois do clique (antes de ler o ID), a retentativa não
        reenvia o pedido; o Collector recupera o ID pela IE e pela data de criação.
        """

        async def mark() -> None:
            submitted = now_utc()
            await self.repo.update_task(
                task.id,
                status=TaskStatus.SCHEDULED.value,
                requested_at=submitted,
                result={"submitted_at": submitted.isoformat()},
            )
            task.status = TaskStatus.SCHEDULED
            task.requested_at = submitted
            await logger.debug(f"{task.task_type}: marcada como enviada antes do clique.", step="scheduling")

        return mark

    # -- desfechos ---------------------------------------------------------------
    async def _finish_without_work(self, job: Job, reporter: JobReporter, all_tasks: list[Task]) -> None:
        """Nenhuma tarefa pendente (ex.: reprocessamento após sucesso parcial)."""
        if any(t.status in (TaskStatus.SCHEDULED, TaskStatus.PROCESSED) for t in all_tasks):
            await reporter.set_final(
                JobStatus.WAITING_SEFAZ,
                next_check_at=now_utc(),
                last_message="Aguardando processamento SEFAZ",
                locked_at=None,
                locked_by=None,
            )
        elif any(t.status in (TaskStatus.COMPLETED, TaskStatus.DRY_RUN, TaskStatus.SKIPPED) for t in all_tasks):
            await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message="Nada pendente para agendar")
        else:
            await reporter.set_final(
                JobStatus.FAILED,
                finished_at=now_utc(),
                error_code=ErrorCode.INVALID_CONFIGURATION.value,
                error_message="Job sem tarefas de exportação pendentes.",
                last_message="Job sem tarefas de exportação pendentes.",
            )

    async def _finish_after_scheduling(
        self, job: Job, reporter: JobReporter, tasks: list[Task], logger: JobLogger
    ) -> None:
        scheduled = [t for t in tasks if t.status == TaskStatus.SCHEDULED]
        dry = [t for t in tasks if t.status == TaskStatus.DRY_RUN]
        if scheduled:
            interval = int(await self.repo.get_setting("collector_interval_minutes", self.settings.collector_interval_minutes))
            await reporter.set_final(
                JobStatus.WAITING_SEFAZ,
                next_check_at=now_utc() + timedelta(minutes=interval),
                last_message=f"Aguardando processamento SEFAZ ({len(scheduled)} agendamento(s))",
                locked_at=None,
                locked_by=None,
            )
            await logger.info(f"Navegador fechado. Collector consultará em {interval} min.", step="waiting_sefaz")
            return
        message = (
            f"Simulação concluída: {len(dry)} formulário(s) preenchido(s), nenhum agendamento enviado."
            if dry
            else "Exportação já agendada."
        )
        await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)
        await logger.info(message, step="completed")

    async def _requeue_after_interrupt(self, job: Job, tasks: list[Task]) -> None:
        for t in tasks:
            if t.status == TaskStatus.RUNNING:
                await self.repo.update_task(t.id, status=TaskStatus.PENDING.value)
        await self.repo.update_job(
            job.id,
            status=JobStatus.QUEUED.value,
            current_step=JobStatus.QUEUED.value,
            progress=0,
            attempts=max(0, job.attempts - 1),
            next_attempt_at=now_utc(),
            manual_action_message=None,
            last_message="Worker interrompido; job devolvido à fila.",
        )

    async def _cancelled(self, job: Job, reporter: JobReporter, tasks: list[Task], logger: JobLogger) -> None:
        for t in tasks:
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                await self.repo.update_task(t.id, status=TaskStatus.CANCELLED.value, finished_at=now_utc())
        await self.repo.update_job(
            job.id,
            status=JobStatus.CANCELLED.value,
            current_step=JobStatus.CANCELLED.value,
            finished_at=now_utc(),
            last_message="Cancelado pelo usuário",
        )
        await logger.warning("Automação cancelada pelo usuário.", step="cancelled")

    async def _failed(
        self,
        job: Job,
        reporter: JobReporter,
        tasks: list[Task],
        logger: JobLogger,
        ctx: AutomationContext | None,
        exc: BaseException,
    ) -> None:
        code, message = self.describe(exc)
        screenshot = await self.error_screenshot(ctx, job, logger)
        await logger.error(f"[{code}] {message}", step=reporter.state.value, metadata={"error_code": code.value})

        running = [t for t in tasks if t.status == TaskStatus.RUNNING]
        if code in (ErrorCode.CERTIFICATE_REQUIRED, ErrorCode.CERTIFICATE_EXPIRED):
            await self.repo.update_job(
                job.id,
                status=JobStatus.CERTIFICATE_REQUIRED.value,
                current_step=JobStatus.CERTIFICATE_REQUIRED.value,
                error_code=code.value,
                error_message=message,
                error_screenshot_path=screenshot,
                last_message=message,
                finished_at=now_utc(),
            )
            for t in running:
                await self.repo.update_task(t.id, status=TaskStatus.PENDING.value)
            return

        decision = self.deps.retry_policy.decide(exc, job.attempts)
        if decision.retry:
            for t in running:
                await self.repo.update_task(t.id, status=TaskStatus.PENDING.value, retry_count=t.retry_count + 1)
            await self.repo.update_job(
                job.id,
                status=JobStatus.QUEUED.value,
                current_step=JobStatus.QUEUED.value,
                progress=0,
                next_attempt_at=decision.next_attempt_at,
                error_code=code.value,
                error_message=message,
                error_screenshot_path=screenshot,
                last_message=f"Erro: {message}. Nova tentativa em {decision.delay_seconds}s.",
            )
            await logger.warning(decision.reason, step="retry")
            return

        for t in tasks:
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                await self.repo.update_task(
                    t.id, status=TaskStatus.FAILED.value, error_message=message, finished_at=now_utc()
                )
        await self.repo.update_job(
            job.id,
            status=JobStatus.FAILED.value,
            current_step=JobStatus.FAILED.value,
            error_code=code.value,
            error_message=message,
            error_screenshot_path=screenshot,
            finished_at=now_utc(),
            last_message=f"Erro: {message}",
        )
        if isinstance(exc, AutomationError) and not exc.retryable:
            await logger.error(f"Erro {code} não permite retentativa automática.", step="failed")
        else:
            await logger.error(decision.reason, step="failed")
