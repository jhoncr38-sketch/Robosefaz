"""Coleta dos agendamentos: aplicar a situação lida na lista do SIAT (baixar, "sem notas", erro) e
concluir o trabalho. Usada pelo Collector (consulta periódica) e pelo Scheduler (conferência rápida
logo depois de agendar, desde a 1.2.35)."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from app.downloads.note_index import index_download_now
from app.downloads.organizer import EmptyExportError
from app.jobs.base_runner import now_utc
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import DOC_LABEL, ExportStatus, ExportStatusResult, Job, Task, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger

if TYPE_CHECKING:
    from app.automation.base import AutomationContext, AutomationProvider
    from app.config import Settings
    from app.jobs.repository import JobRepository

# falhas de download que valem nova tentativa espaçada (a linha pode ainda não ter o botão, etc.)
DOWNLOAD_SOFT_ERRORS = frozenset({ErrorCode.SELECTOR_NOT_FOUND, ErrorCode.DOWNLOAD_FAILED, ErrorCode.TIMEOUT})
DOWNLOAD_MAX_FAILURES = 5
# nota pela chave: consultas mais seguidas (o SIAT processa um pedido de uma nota em poucos minutos)
KEY_CHECK_MINUTES = 2
DOWNLOAD_BACKOFF_MINUTES = (5, 15, 30, 60)

FINAL_TASK_STATUSES = frozenset(
    {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.SKIPPED, TaskStatus.CANCELLED, TaskStatus.DRY_RUN}
)


class ExportCollection:
    """Mistura para os runners: precisa de `self.repo` e `self.settings` (BaseRunner)."""

    repo: "JobRepository"
    settings: "Settings"

    async def _interval_minutes(self) -> int:
        return int(await self.repo.get_setting("collector_interval_minutes", self.settings.collector_interval_minutes))

    async def _max_checks(self) -> int:
        return int(await self.repo.get_setting("collector_max_checks", self.settings.collector_max_checks))

    async def _record_check(self, job: Job, statuses: list[ExportStatusResult], *, quick: bool = False) -> None:
        summary = [s.model_dump(mode="json") for s in statuses]
        result: dict = {"check": job.check_count, "statuses": summary}
        if quick:
            result["quick"] = True  # conferência rápida, logo depois de agendar
        await self.repo.create_task(
            job_id=job.id,
            client_id=job.client_id,
            task_type=TaskType.CHECK_PROCESSING,
            competence=job.competence,
            status=TaskStatus.COMPLETED,
            result=result,
        )

    async def _apply_statuses(
        self,
        job: Job,
        ctx: "AutomationContext",
        provider: "AutomationProvider",
        reporter: JobReporter,
        logger: JobLogger,
        pending: list[Task],
        statuses: list[ExportStatusResult],
        *,
        quick: bool = False,
    ) -> list[int]:
        """Baixa o que está "Processado", marca "sem notas" e erros da SEFAZ. Devolve os minutos de
        espera pedidos por downloads que falharam (para espaçar a próxima tentativa).

        `quick`: conferência rápida logo depois de agendar. O que não está pronto (ou não aparece na
        lista) fica para a consulta normal, sem marcar nada como falho; um download que falha
        também fica para ela (não tenta de novo na mesma sessão).
        """
        retry_minutes: list[int] = []
        for task, st in zip(pending, statuses, strict=True):
            await reporter.check_cancel()
            if st.external_request_id and not task.external_request_id:
                await self.repo.update_task(task.id, external_request_id=st.external_request_id)
                task.external_request_id = st.external_request_id
            if st.status == ExportStatus.PROCESSED:
                await self.repo.update_task(task.id, status=TaskStatus.PROCESSED.value)
                task.status = TaskStatus.PROCESSED
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
                except EmptyExportError:
                    # ZIP vazio: igual a "Processado sem notas" (nada é salvo)
                    await self.repo.update_task(
                        download_task.id,
                        status=TaskStatus.COMPLETED.value,
                        finished_at=now_utc(),
                        result={"export_task_id": task.id, "no_notes": True},
                    )
                    await self.repo.update_task(
                        task.id,
                        status=TaskStatus.COMPLETED.value,
                        finished_at=now_utc(),
                        result={"no_notes": True, "raw_status": "ZIP vazio"},
                    )
                    task.status = TaskStatus.COMPLETED
                    task.result = {"no_notes": True}
                    await logger.info(
                        f"{task.task_type}: o SIAT entregou um ZIP vazio: nenhuma nota no período (nada a salvar).",
                        step="downloading",
                    )
                    continue
                except AutomationError as exc:
                    await self.repo.update_task(
                        download_task.id,
                        status=TaskStatus.FAILED.value,
                        error_message=exc.message,
                        finished_at=now_utc(),
                    )
                    if exc.code not in DOWNLOAD_SOFT_ERRORS:
                        raise  # ex.: contribuinte errado -> para tudo
                    # uma nota com problema não impede as outras; nova tentativa espaçada
                    retry = await self._download_failed(job, task, exc, logger)
                    if retry is not None:
                        retry_minutes.append(retry)
                    continue
                except Exception as exc:
                    # erro inesperado (navegador fechou, internet): registra no download e repassa
                    await self.repo.update_task(
                        download_task.id,
                        status=TaskStatus.FAILED.value,
                        error_message=f"{type(exc).__name__}: {exc}"[:500],
                        finished_at=now_utc(),
                    )
                    raise
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
                if job.note_key:
                    # quem pediu está esperando na tela de busca: índice na hora (sem esperar a manutenção)
                    await self._index_now(download_row, stored, logger)
                await self.repo.update_task(
                    download_task.id,
                    status=TaskStatus.COMPLETED.value,
                    finished_at=now_utc(),
                    result={"export_task_id": task.id, **stored.model_dump(mode="json")},
                )
                await self.repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc())
                task.status = TaskStatus.COMPLETED
                if quick:
                    await logger.info(
                        f"{task.task_type}: já estava pronto; baixado logo depois de agendar.", step="downloading"
                    )
            elif st.status == ExportStatus.EMPTY:
                # SIAT: "Processado sem notas" -> não houve nota no período; nada a baixar
                await self.repo.update_task(
                    task.id,
                    status=TaskStatus.COMPLETED.value,
                    finished_at=now_utc(),
                    result={"no_notes": True, "raw_status": st.raw_status},
                )
                task.status = TaskStatus.COMPLETED
                task.result = {"no_notes": True}
                await logger.info(
                    f"{task.task_type}: processado sem notas no período (nada a baixar).",
                    step="checking_processing",
                )
            elif st.status == ExportStatus.ERROR:
                await self.repo.update_task(
                    task.id,
                    status=TaskStatus.FAILED.value,
                    error_message=f"SEFAZ retornou erro no processamento: {st.raw_status or ''}"[:500],
                    finished_at=now_utc(),
                )
                task.status = TaskStatus.FAILED
                await logger.error(f"{task.task_type}: SEFAZ retornou erro.", step="checking_processing")
            elif quick:
                continue  # ainda processando (ou ainda não visível na lista): fica para a consulta normal
            elif st.status == ExportStatus.NOT_FOUND and job.note_key and not task.external_request_id:
                # nota pela chave: o SIAT não agenda (entrega o arquivo no clique); sem ID não há
                # o que esperar na lista. Falha já, para o Reprocessar refazer o pedido do zero.
                await self.repo.update_task(
                    task.id,
                    status=TaskStatus.FAILED.value,
                    error_message="A exportação pela chave não gerou agendamento nem arquivo; use Reprocessar.",
                    finished_at=now_utc(),
                )
                task.status = TaskStatus.FAILED
                await logger.error(
                    f"{task.task_type}: nenhum agendamento na lista e nenhum arquivo recebido; use Reprocessar.",
                    step="checking_processing",
                )
            elif st.status == ExportStatus.NOT_FOUND:
                await logger.warning(
                    f"{task.task_type}: agendamento não localizado na lista do portal.",
                    step="checking_processing",
                )
            else:
                await logger.info(f"{task.task_type}: ainda em processamento.", step="checking_processing")
        return retry_minutes

    async def _index_now(self, download_row: dict, stored, logger: JobLogger) -> None:  # noqa: ANN001
        """Nota pela chave: lê o ZIP recém-gravado e põe a nota no índice na hora."""
        try:
            n = await index_download_now(self.repo, download_row, Path(stored.filepath), stored.document_type.value)
            if n is None:
                return
            await logger.info(f"Nota pela chave: {n} nota(s) no arquivo; já disponível na busca.", step="organizing_files")
        except Exception as exc:  # noqa: BLE001 - a manutenção indexa depois
            await logger.warning(f"Não foi possível indexar a nota agora ({exc}); a manutenção fará em seguida.", step="organizing_files")

    async def _download_failed(self, job: Job, task: Task, exc: AutomationError, logger: JobLogger) -> int | None:
        """Conta as falhas de download desta nota: espaça as tentativas e desiste após o limite."""
        failures = sum(
            1
            for t in await self.repo.list_tasks(job.id)
            if t.task_type == TaskType.DOWNLOAD
            and t.status == TaskStatus.FAILED
            and t.result.get("export_task_id") == task.id
        )
        if failures >= DOWNLOAD_MAX_FAILURES:
            message = (
                f"Download falhou {failures} vezes ({exc.message}). "
                f"Verifique o agendamento {task.external_request_id} no SIAT."
            )
            await self.repo.update_task(task.id, status=TaskStatus.FAILED.value, error_message=message[:500], finished_at=now_utc())
            task.status = TaskStatus.FAILED
            await logger.error(f"{task.task_type}: {message}", step="downloading")
            return None
        wait = DOWNLOAD_BACKOFF_MINUTES[min(failures, len(DOWNLOAD_BACKOFF_MINUTES)) - 1]
        await logger.warning(
            f"{task.task_type}: download falhou ({failures}/{DOWNLOAD_MAX_FAILURES}): {exc.message} "
            f"Nova tentativa em {wait} min.",
            step="downloading",
        )
        return wait

    async def _conclude(
        self, job: Job, reporter: JobReporter, tasks: list[Task], logger: JobLogger, *, retry_in: int | None = None
    ) -> None:
        exports = [t for t in tasks if t.is_export and not t.superseded]
        if exports and all(t.status in FINAL_TASK_STATUSES for t in exports):
            if any(t.status == TaskStatus.COMPLETED for t in exports):
                failed = [t for t in exports if t.status == TaskStatus.FAILED]
                msg = "Concluído" if not failed else f"Concluído com {len(failed)} exportação(ões) com erro"
                empty = [DOC_LABEL.get(str(t.document_type), str(t.document_type)) for t in exports if t.result.get("no_notes")]
                if job.note_key and empty:
                    # nota pela chave: o SIAT não entregou nada -> a nota não é desta empresa (ou ainda não consta)
                    msg = "Nota não encontrada no SIAT com o certificado desta empresa"
                elif job.note_key:
                    msg = "Nota exportada do SIAT e disponível na tela Notas"
                elif empty:
                    msg += f" ({', '.join(empty)} sem notas no período)"
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
        if retry_in is not None:
            interval = min(interval, retry_in)
        if job.note_key:
            interval = min(interval, KEY_CHECK_MINUTES)  # uma nota só: o SIAT processa em poucos minutos
        await reporter.set_final(
            JobStatus.WAITING_SEFAZ,
            next_check_at=now_utc() + timedelta(minutes=interval),
            last_message=f"Aguardando processamento SEFAZ (próxima consulta em {interval} min)",
        )
