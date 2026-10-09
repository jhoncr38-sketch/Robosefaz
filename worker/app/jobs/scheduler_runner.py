"""ROBÔ 1 — Scheduler: cria os agendamentos de exportação no portal.

Após agendar, o job vai para `waiting_sefaz` e o navegador é FECHADO;
o Collector retoma depois.
"""

from __future__ import annotations

import asyncio
import time

from datetime import datetime, timedelta
from pathlib import Path

from app.automation.base import AutomationContext
from app.downloads.note_index import index_download_now
from app.jobs.base_runner import BaseRunner, now_utc
from app.jobs.collect import ExportCollection
from app.jobs.dedup import DuplicateGuard
from app.jobs.efd_check import run_efd_check
from app.jobs.malha_check import run_malha_check
from app.jobs.errors import AutomationError, ErrorCode, JobCancelled, TaxpayerMismatchError
from app.jobs.models import EXPORT_TASK_TYPES, ExportRequestResult, Job, Task, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger

TASK_STEP: dict[TaskType, JobStatus] = {
    TaskType.NFCE_EXPORT: JobStatus.SCHEDULING_NFCE,
    TaskType.NFE_ISSUED_EXPORT: JobStatus.SCHEDULING_NFE_ISSUED,
    TaskType.NFE_RECEIVED_EXPORT: JobStatus.SCHEDULING_NFE_RECEIVED,
    TaskType.NFCE_CANCELED_EXPORT: JobStatus.SCHEDULING_NFCE,
    TaskType.NFE_ISSUED_CANCELED_EXPORT: JobStatus.SCHEDULING_NFE_ISSUED,
    TaskType.NFE_RECEIVED_CANCELED_EXPORT: JobStatus.SCHEDULING_NFE_RECEIVED,
    TaskType.NFE_KEY_EXPORT: JobStatus.SCHEDULING_NFE_RECEIVED,
}

# nota pela chave: o SIAT processa um pedido de uma nota só em poucos minutos
KEY_CHECK_MINUTES = 2

# Ordem fixa das operações (NFC-e -> NF-e emitidas -> NF-e recebidas)
TASK_ORDER = {t: i for i, t in enumerate(EXPORT_TASK_TYPES)}


class SchedulerRunner(ExportCollection, BaseRunner):
    phase = "schedule"

    async def run_once(self) -> bool:
        job = await self.repo.claim_next_job(self.deps.worker_id)
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

            # consulta do processamento da EFD (DT-e): não agenda nada, conclui na hora
            efd_tasks = [
                t
                for t in all_tasks
                if t.task_type == TaskType.EFD_CHECK
                and not t.superseded
                and t.status in (TaskStatus.PENDING, TaskStatus.RUNNING)
            ]
            if efd_tasks:
                tasks = efd_tasks
                provider = self.deps.registry.get(job.provider)
                ctx = self.build_context(job, client, certificate, reporter, logger)
                await run_efd_check(self.repo, provider, ctx, job, efd_tasks, reporter, logger)
                return

            # Consulta de Malhas Fiscais (SIAT web): só lê, conclui na hora
            malha_tasks = [
                t
                for t in all_tasks
                if t.task_type == TaskType.MALHA_CHECK
                and not t.superseded
                and t.status in (TaskStatus.PENDING, TaskStatus.RUNNING)
            ]
            if malha_tasks:
                tasks = malha_tasks
                provider = self.deps.registry.get(job.provider)
                ctx = self.build_context(job, client, certificate, reporter, logger)
                await run_malha_check(self.repo, provider, ctx, job, malha_tasks, reporter, logger)
                return

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
                    if task.task_type != TaskType.NFE_KEY_EXPORT:
                        # marca "enviada" antes do clique para uma retentativa não repetir o pedido;
                        # na nota pela chave o SIAT não agenda (entrega o arquivo no clique), então
                        # repetir é inofensivo e a tarefa precisa continuar "em andamento" para o
                        # Reprocessar refazê-la se algo falhar depois do clique
                        ctx.on_submit = self._submit_marker(task, logger)
                        ctx.on_rejected = self._submit_unmark(task, logger)
                    result = await provider.schedule(ctx, task)
                    ctx.on_submit = ctx.on_rejected = None
                    if result.downloaded is not None or result.no_notes:
                        # nota pela chave: o SIAT entregou o arquivo no clique; nada a coletar depois
                        await self._complete_direct(job, task, result, logger)
                        continue
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
                    # a conferência rápida usa estes dados na mesma sessão: com o número do pedido em
                    # mãos, ela localiza a linha direto (sem recuperar o ID pela data de criação)
                    task.external_request_id = result.external_request_id
                    task.requested_at = result.requested_at
                    await logger.info(
                        f"{task.task_type}: {'simulado (dry-run)' if result.dry_run else 'agendado'}"
                        f"{' - protocolo ' + result.external_request_id if result.external_request_id else ''}.",
                        step=TASK_STEP[task.task_type].value,
                    )

                quick = await self._quick_collect(job, ctx, provider, reporter, logger, tasks)

            if quick is not None:
                await self._finish_after_quick(job, reporter, logger, retry_in=quick)
            else:
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

    async def _complete_direct(self, job: Job, task: Task, result: ExportRequestResult, logger: JobLogger) -> None:
        """Nota pela chave: o SIAT entrega o ZIP no clique em "Exportar" (sem agendamento). Registra
        o download, indexa na hora e encerra a tarefa, como o Collector faria."""
        stored = result.downloaded
        if stored is None:
            await self.repo.update_task(
                task.id,
                status=TaskStatus.COMPLETED.value,
                finished_at=now_utc(),
                result={"no_notes": True, "raw_status": "ZIP vazio", "raw_message": result.raw_message},
            )
            task.status = TaskStatus.COMPLETED
            task.result = {"no_notes": True}
            await logger.info(
                "Nota pela chave: o SIAT devolveu um ZIP vazio; a nota não consta para este contribuinte.", step="scheduling"
            )
            return
        download_task = await self.repo.create_task(
            job_id=job.id,
            client_id=job.client_id,
            task_type=TaskType.DOWNLOAD,
            competence=job.competence,
            status=TaskStatus.COMPLETED,
            document_type=stored.document_type,
            result={"export_task_id": task.id, **stored.model_dump(mode="json")},
        )
        download_row = await self.repo.insert_download(
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
            **({"note_key": job.note_key} if job.note_key else {}),
        )
        indexed: int | None = None
        try:
            indexed = await index_download_now(self.repo, download_row, Path(stored.filepath), stored.document_type.value)
        except Exception as exc:  # noqa: BLE001 - a manutenção indexa depois
            await logger.warning(f"Não foi possível indexar a nota agora ({exc}); a manutenção fará em seguida.", step="organizing_files")
        await self.repo.update_task(
            task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc(), result=result.model_dump(mode="json")
        )
        task.status = TaskStatus.COMPLETED
        task.result = {"downloaded": True}
        await logger.info(
            f"Nota pela chave exportada na hora: {stored.filename}"
            + (f" ({indexed} nota(s) já na tela Notas)." if indexed is not None else "."),
            step="organizing_files",
        )

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

    def _submit_unmark(self, task: Task, logger: JobLogger):  # noqa: ANN202
        """O SIAT respondeu sem criar pedido ("já existe"/recusa): a tarefa volta a "em andamento"."""

        async def unmark() -> None:
            await self.repo.update_task(task.id, status=TaskStatus.RUNNING.value, requested_at=None, result={})
            task.status = TaskStatus.RUNNING
            task.requested_at = None
            await logger.debug(f"{task.task_type}: SIAT não criou pedido; marcação de envio desfeita.", step="scheduling")

        return unmark

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

    async def _quick_collect(
        self,
        job: Job,
        ctx: AutomationContext,
        provider,  # noqa: ANN001 - AutomationProvider
        reporter: JobReporter,
        logger: JobLogger,
        tasks: list[Task],
    ) -> int | None:
        """Conferência rápida (1.2.35): com o navegador ainda aberto e logado, confere a lista do SIAT
        logo depois de agendar e baixa o que já ficou pronto; repete a cada `quick_check_interval_seconds`
        até `quick_check_seconds`. Inclui o agendamento que já existia no SIAT (feito à mão antes) e já
        está "Processado": baixa na primeira conferência, sem espera.

        É um bônus: qualquer falha aqui (SIAT fora, internet, página lenta) só registra um aviso e o
        trabalho segue como antes, para a consulta normal. Nunca agenda nem exclui nada. Só o erro de
        contribuinte errado e o cancelamento interrompem o trabalho.

        None = não houve conferência rápida (fluxo antigo). Senão, os minutos pedidos por downloads
        que falharam (0 = nenhum), para espaçar a próxima consulta.
        """
        pending = [t for t in tasks if t.status == TaskStatus.SCHEDULED and t.is_export]
        if not pending or ctx.dry_run:
            return None
        budget = float(await self.repo.get_setting("quick_check_seconds", self.settings.quick_check_seconds) or 0)
        interval = float(
            await self.repo.get_setting("quick_check_interval_seconds", self.settings.quick_check_interval_seconds) or 0
        )
        if budget <= 0:
            return None
        if self.deps.stopping():
            await logger.info("Robô encerrando: conferência rápida pulada.", step="checking_processing")
            return None
        governor = self.deps.quick_check
        if not governor.should_run(time.monotonic()):
            back = datetime.now() + timedelta(seconds=governor.remaining_seconds(time.monotonic()))
            await logger.info(
                "Conferência rápida em pausa automática: nos últimos clientes nada ficou pronto na hora "
                f"(SEFAZ lenta). Este computador volta a conferir às {back:%H:%M}.",
                step="checking_processing",
            )
            return None
        original = list(pending)
        interrupted = False
        loop = asyncio.get_running_loop()
        deadline = loop.time() + budget
        retry: list[int] = []
        await logger.info(
            f"Conferindo se a SEFAZ já processou {len(pending)} pedido(s) antes de fechar o navegador "
            f"(até {int(budget)} s).",
            step="checking_processing",
        )
        try:
            while True:
                await reporter.step(JobStatus.CHECKING_PROCESSING, "Conferindo se a SEFAZ já processou")
                statuses = await provider.check_status(ctx, pending)
                await self._record_check(job, statuses, quick=True)
                retry += await self._apply_statuses(job, ctx, provider, reporter, logger, pending, statuses, quick=True)
                pending = [t for t in pending if t.status == TaskStatus.SCHEDULED]
                if not pending or loop.time() + interval > deadline:
                    break
                if not await self._pause(interval, reporter):
                    await logger.info("Robô encerrando: conferência rápida interrompida.", step="checking_processing")
                    interrupted = True
                    break
        except (JobCancelled, TaxpayerMismatchError):
            raise
        except AutomationError as exc:
            if exc.code in (ErrorCode.TAXPAYER_MISMATCH, ErrorCode.SECURITY_CLIENT_MISMATCH):
                raise
            await logger.warning(
                f"Conferência rápida não foi possível ({exc.message}); os pedidos serão conferidos na consulta normal.",
                step="checking_processing",
            )
        except Exception as exc:  # noqa: BLE001 - bônus: nunca derruba o trabalho
            await logger.warning(
                f"Conferência rápida não foi possível ({type(exc).__name__}: {exc}); "
                "os pedidos serão conferidos na consulta normal.",
                step="checking_processing",
            )
        # algo ficou pronto (baixado, sem notas, erro da SEFAZ ou download a refazer)?
        found = any(t.status != TaskStatus.SCHEDULED for t in original)
        was_probing = governor.probing
        if interrupted and not found:
            return min(retry) if retry else 0  # robô encerrando no meio: não conta como "SEFAZ lenta"
        if governor.record(found, time.monotonic()):
            minutes = round(governor.pause_seconds / 60)
            await logger.info(
                f"Nada ficou pronto na conferência rápida dos últimos clientes: a SEFAZ parece lenta. "
                f"Este computador pula a conferência por {minutes} min e depois tenta de novo.",
                step="checking_processing",
            )
        elif found and was_probing:
            await logger.info("Conferência rápida voltou ao normal: a SEFAZ já está processando na hora.", step="checking_processing")
        return min(retry) if retry else 0

    async def _pause(self, seconds: float, reporter: JobReporter) -> bool:
        """Espera entre conferências, atenta a cancelamento e ao robô encerrando. False = encerrando."""
        loop = asyncio.get_running_loop()
        end = loop.time() + seconds
        last_cancel_check = loop.time()
        while (remaining := end - loop.time()) > 0:
            if self.deps.stopping():
                return False
            await asyncio.sleep(min(1.0, remaining))
            if loop.time() - last_cancel_check >= 5:
                await reporter.check_cancel()
                last_cancel_check = loop.time()
        return not self.deps.stopping()

    async def _finish_after_quick(
        self, job: Job, reporter: JobReporter, logger: JobLogger, *, retry_in: int
    ) -> None:
        """Depois da conferência rápida: conclui se tudo ficou pronto; senão, segue para a consulta normal."""
        refreshed = await self.repo.list_tasks(job.id)
        exports = [t for t in refreshed if t.is_export and not t.superseded]
        done = sum(1 for t in exports if t.status == TaskStatus.COMPLETED)
        await self._conclude(job, reporter, refreshed, logger, retry_in=retry_in or None)
        waiting = [t for t in exports if t.status in (TaskStatus.SCHEDULED, TaskStatus.PROCESSED)]
        if waiting:
            await logger.info(
                f"Navegador fechado: {done} de {len(exports)} pedido(s) já resolvido(s) na conferência rápida; "
                f"{len(waiting)} seguem para a consulta normal.",
                step="waiting_sefaz",
            )

    async def _finish_after_scheduling(
        self, job: Job, reporter: JobReporter, tasks: list[Task], logger: JobLogger
    ) -> None:
        scheduled = [t for t in tasks if t.status == TaskStatus.SCHEDULED]
        dry = [t for t in tasks if t.status == TaskStatus.DRY_RUN]
        done = [t for t in tasks if t.status == TaskStatus.COMPLETED]
        if not scheduled and done and job.note_key:
            # nota pela chave entregue no clique: o trabalho termina aqui
            found = any(not t.result.get("no_notes") for t in done)
            message = (
                "Nota exportada do SIAT e disponível na tela Notas"
                if found
                else "Nota não encontrada no SIAT com o certificado desta empresa"
            )
            await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)
            await logger.info(message, step="completed")
            return
        if scheduled:
            interval = int(await self.repo.get_setting("collector_interval_minutes", self.settings.collector_interval_minutes))
            if job.note_key:
                interval = min(interval, KEY_CHECK_MINUTES)
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
        running = [t for t in tasks if t.status == TaskStatus.RUNNING]
        if await self.hand_over(job, logger, exc, collect=False):
            for t in running:
                await self.repo.update_task(t.id, status=TaskStatus.PENDING.value)
            return
        code, message = self.describe(exc)
        screenshot = await self.error_screenshot(ctx, job, logger)
        await logger.error(f"[{code}] {message}", step=reporter.state.value, metadata={"error_code": code.value})

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
