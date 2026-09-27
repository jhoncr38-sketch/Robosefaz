"""Consulta do processamento da EFD (tarefa EFD_CHECK).

Entra no SIAT com o certificado do cliente, lê as notificações "EPE - EFD" da
competência no DT-e, grava cada declaração em efd_declarations e conclui o job
com o resultado (a declaração que vale é a processada por último: uma
retificadora substitui a original).
"""

from __future__ import annotations

import re

from app.automation.base import AutomationContext, AutomationProvider
from app.efd.parser import EfdMessage, EfdSituation, latest, parse_message
from app.jobs.base_runner import now_utc
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Job, Task, TaskStatus
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger

SITUATION_TEXT = {
    EfdSituation.PROCESSED: "processada",
    EfdSituation.ALERT: "processada com malha fiscal (alerta)",
    EfdSituation.PENDING: "processada com pendência",
    EfdSituation.NOT_PROCESSED: "NÃO processada",
}


def _digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def summary(competence: str, messages: list[EfdMessage]) -> str:
    comp = f"{competence[5:7]}/{competence[:4]}"
    final = latest(messages)
    if final is None:
        return f"EFD {comp}: nenhuma mensagem de processamento no DT-e."
    if final.situation == EfdSituation.NOT_PROCESSED and (final.finalidade or "").upper() == "RETIFICADORA":
        valid = latest([m for m in messages if m.situation != EfdSituation.NOT_PROCESSED])
        if valid is not None:
            # retificadora rejeitada não substitui nada: continua valendo a anterior
            return (
                f"EFD {comp}: retificadora NÃO processada; vale a "
                f"{(valid.finalidade or 'declaração').lower()} {SITUATION_TEXT[valid.situation]}."
            )
    text = f"EFD {comp}: {SITUATION_TEXT[final.situation]}"
    if final.finalidade:
        text += f" ({final.finalidade.lower()})"
    return text + "."


def ensure_same_taxpayer(ctx: AutomationContext, msg: EfdMessage) -> None:
    """Nunca grava declaração de outro contribuinte (mensagem com IE/CNPJ diferente do cliente)."""
    client_ie = _digits(ctx.client.state_registration)
    client_cnpj = _digits(ctx.client.cnpj)
    if client_ie and msg.state_registration and msg.state_registration != client_ie:
        raise AutomationError(
            ErrorCode.SECURITY_CLIENT_MISMATCH,
            f"Mensagem da EFD {msg.epe_number} é de outra inscrição estadual ({msg.state_registration}).",
        )
    # o SIAT às vezes omite o zero à esquerda do CNPJ (ex.: 5731045000150)
    if client_cnpj.isdigit() and msg.cnpj and msg.cnpj.zfill(14) != client_cnpj.zfill(14):
        raise AutomationError(
            ErrorCode.SECURITY_CLIENT_MISMATCH,
            f"Mensagem da EFD {msg.epe_number} é de outro CNPJ ({msg.cnpj}).",
        )


async def run_efd_check(
    repo: JobRepository,
    provider: AutomationProvider,
    ctx: AutomationContext,
    job: Job,
    tasks: list[Task],
    reporter: JobReporter,
    logger: JobLogger,
) -> None:
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.RUNNING.value, started_at=now_utc())
        task.status = TaskStatus.RUNNING

    async with provider.open_session(ctx):
        await provider.login(ctx)
        await provider.select_company(ctx)
        await reporter.check_cancel()
        raw = await provider.read_efd_messages(ctx, job.competence)

    messages: list[EfdMessage] = []
    for item in raw:
        msg = parse_message(item.text)
        if msg is None:
            await logger.warning(f"Mensagem '{item.subject}' sem os dados da EFD; ignorada.", step="checking_processing")
            continue
        ensure_same_taxpayer(ctx, msg)
        if msg.competence and msg.competence != job.competence:
            continue
        messages.append(msg)
        await repo.upsert_efd_declaration(
            client_id=job.client_id,
            job_id=job.id,
            competence=job.competence,
            epe_number=msg.epe_number,
            finalidade=msg.finalidade,
            processed=msg.processed,
            situation=msg.situation.value,
            processed_at=msg.processed_at,
            received_at=msg.received_at,
            message_sent_at=item.sent_at,
            subject=item.subject,
            inconsistencies=[i.model_dump() for i in msg.inconsistencies],
            raw_text=msg.raw_text,
            checked_at=now_utc(),
        )

    message = summary(job.competence, messages)
    final = latest(messages)
    result = {
        "found": len(messages),
        "situation": final.situation.value if final else None,
        "epe_number": final.epe_number if final else None,
        "finalidade": final.finalidade if final else None,
    }
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc(), result=result)
        task.status = TaskStatus.COMPLETED
    await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)
    await logger.info(message, step="completed")
