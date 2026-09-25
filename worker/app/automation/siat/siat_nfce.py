"""Rotina de agendamento de exportação de NFC-e."""

from __future__ import annotations

from datetime import date

from app.automation.siat.siat_scheduler import SiatExportScheduler
from app.jobs.models import Client, DocumentType, ExportRequestResult


async def schedule_nfce_export(
    scheduler: SiatExportScheduler,
    client: Client,
    start_date: date,
    end_date: date,
    competence: str,
) -> ExportRequestResult:
    """Seleciona NFC-e, informa o período e agenda a exportação."""
    await scheduler.ctx.logger.info(
        f"Agendando exportação NFC-e de {client.client_code} ({competence}).", step="scheduling_nfce"
    )
    return await scheduler.schedule(DocumentType.NFCE, start_date, end_date, competence)
