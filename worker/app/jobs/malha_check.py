"""Consulta de Malhas Fiscais (tarefa MALHA_CHECK).

Entra no SIAT com o certificado do cliente, abre Autoatendimento -> Malhas
Fiscais -> Consulta de Malhas, lê as duas tabelas (DIEF/PGDAS e EFD/OIE), grava
a foto do momento em malha_checks (uma por cliente: a consulta nova substitui
a anterior) e conclui o job com o resumo. Não é por competência: a página do
SIAT mostra tudo o que está em aberto agora.
"""

from __future__ import annotations

from app.automation.base import AutomationContext, AutomationProvider
from app.automation.siat.siat_legacy import ie_matches, only_digits
from app.automation.siat.siat_malhas import MalhaResult, summary
from app.jobs.base_runner import now_utc
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Job, Task, TaskStatus
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger


def ensure_same_taxpayer(ctx: AutomationContext, result: MalhaResult) -> None:
    """Nunca grava malha de outra inscrição (a página do SIAT é do usuário logado)."""
    client_ie = only_digits(ctx.client.state_registration)
    if result.state_registration and not ie_matches(result.state_registration, client_ie):
        raise AutomationError(
            ErrorCode.SECURITY_CLIENT_MISMATCH,
            f"A Consulta de Malhas abriu a inscrição {result.state_registration}, e não a do cliente ({client_ie}).",
        )


async def run_malha_check(
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
        result = await provider.read_malhas(ctx)

    ensure_same_taxpayer(ctx, result)
    checked_at = now_utc()
    await repo.upsert_malha_check(
        client_id=job.client_id,
        job_id=job.id,
        state_registration=result.state_registration,
        legal_name=result.legal_name,
        findings=[f.as_dict() for f in result.findings],
        total=len(result.findings),
        icms_total=result.icms_total,
        nfe_total=result.nfe_total,
        raw_text=result.raw_text,
        checked_at=checked_at,
    )

    message = summary(result)
    task_result = {
        "total": len(result.findings),
        "icms_total": result.icms_total,
        "nfe_total": result.nfe_total,
        "sources": sorted({f.source for f in result.findings}),
    }
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc(), result=task_result)
        task.status = TaskStatus.COMPLETED
    await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)
    await logger.info(message, step="completed")
