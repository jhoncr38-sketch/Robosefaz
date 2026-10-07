"""Rotinas de agendamento de exportação de NF-e (emitente e destinatário)."""

from __future__ import annotations

from datetime import date

from app.automation.siat.siat_scheduler import SiatExportScheduler
from app.jobs.models import DOC_LABEL, Client, DocumentType, ExportRequestResult, base_document


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


async def schedule_nfe_key_export(
    scheduler: SiatExportScheduler,
    client: Client,
    chave: str,
    document_type: DocumentType,
    competence: str,
) -> ExportRequestResult:
    """Uma nota só, pela chave de acesso ("Pesquisar SOMENTE pela Chave da NFE" -> Exportar).

    O SIAT não pergunta emitente/destinatário: ele entrega a nota se ela pertencer ao contribuinte
    logado. `document_type` (emitida/recebida) já vem decidido pela chave, para a pasta certa.
    """
    await scheduler.ctx.logger.info(
        f"Exportando a NF-e de chave {chave} ({DOC_LABEL[document_type.value]} de {client.client_code}, {competence}).",
        step="scheduling_nfe_received" if document_type == DocumentType.NFE_RECEBIDAS else "scheduling_nfe_issued",
    )
    return await scheduler.schedule_by_key(chave, document_type, competence)


_CANCELED_STEP = {
    DocumentType.NFCE: "scheduling_nfce",
    DocumentType.NFE_EMITIDAS: "scheduling_nfe_issued",
    DocumentType.NFE_RECEBIDAS: "scheduling_nfe_received",
}


async def schedule_canceled_export(
    scheduler: SiatExportScheduler,
    client: Client,
    start_date: date,
    end_date: date,
    competence: str,
    *,
    document_type: DocumentType,
) -> ExportRequestResult:
    """Notas canceladas (NFC-e, NF-e emitidas ou recebidas): a mesma tela, com Status "Canceladas"."""
    await scheduler.ctx.logger.info(
        f"Agendando exportação {DOC_LABEL[document_type.value]} de {client.client_code} ({competence}).",
        step=_CANCELED_STEP[base_document(document_type)],
    )
    return await scheduler.schedule(document_type, start_date, end_date, competence)
