"""Rotinas de agendamento de exportação de NF-e (emitente e destinatário)."""

from __future__ import annotations

from datetime import date

from app.automation.siat.siat_scheduler import SiatExportScheduler
from app.jobs.models import Client, DocumentType, ExportRequestResult


async def schedule_nfe_issued_export(
    scheduler: SiatExportScheduler,
    client: Client,
    start_date: date,
    end_date: date,
    competence: str,
) -> ExportRequestResult:
    """NF-e, tipo Emitente."""
    await scheduler.ctx.logger.info(
        f"Agendando exportação NF-e emitidas de {client.client_code} ({competence}).", step="scheduling_nfe_issued"
    )
    return await scheduler.schedule(DocumentType.NFE_EMITIDAS, start_date, end_date, competence)


async def schedule_nfe_received_export(
    scheduler: SiatExportScheduler,
    client: Client,
    start_date: date,
    end_date: date,
    competence: str,
) -> ExportRequestResult:
    """NF-e, tipo Destinatário."""
    await scheduler.ctx.logger.info(
        f"Agendando exportação NF-e recebidas de {client.client_code} ({competence}).", step="scheduling_nfe_received"
    )
    return await scheduler.schedule(DocumentType.NFE_RECEBIDAS, start_date, end_date, competence)
