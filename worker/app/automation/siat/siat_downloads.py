"""Consulta dos agendamentos e download no SIAT web legado.

As listas mostram ID, Situação ("Processado"...), IE e botões Info/Download/Excluir.
Cada tarefa é localizada pelo ID gravado no agendamento; antes de baixar, a IE
da linha precisa ser a IE do cliente (proteção contra cliente errado).
"""

from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable

from playwright.async_api import Error as PlaywrightError, Page, TimeoutError as PlaywrightTimeout

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import first_visible
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_legacy import NFCE, NFE, SiatLegacy, family_of, ie_matches, recover_request_id
from app.downloads.organizer import DownloadFolderUnavailable, InvalidDownloadError
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import DocumentType, DownloadedFile, ExportStatus, ExportStatusResult, Task
from app.jobs.state_machine import JobStatus
from app.utils.files import ensure_dir, safe_name


def classify_status(text: str, sel: SiatSelectors | None = None) -> ExportStatus:
    sel = sel or get_selectors()
    # "erro" primeiro para não confundir "processado com erro"
    if sel.rx("export_status_error").search(text):
        return ExportStatus.ERROR
    if sel.rx("export_status_processed").search(text):
        return ExportStatus.PROCESSED
    if sel.rx("export_status_processing").search(text):
        return ExportStatus.PROCESSING
    return ExportStatus.PENDING


class SiatExportConsult:
    def __init__(
        self,
        ctx: AutomationContext,
        security_check: Callable[[], Awaitable[None]],
        selectors: SiatSelectors | None = None,
    ) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()
        self._security_check = security_check
        self.legacy = SiatLegacy(ctx, self.sel)

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    async def check(self, tasks: list[Task]) -> list[ExportStatusResult]:
        client_ie = self.legacy.require_ie()
        results: dict[str, ExportStatusResult] = {}
        for family in (NFCE, NFE):
            family_tasks = [t for t in tasks if t.document_type and family_of(t.document_type) == family]
            if not family_tasks:
                continue
            await self.legacy.go_to(family)
            claimed = {t.external_request_id for t in tasks if t.external_request_id}
            for task in family_tasks:
                doc = task.document_type or DocumentType.NFCE
                request_id = task.external_request_id
                if not request_id and task.requested_at:
                    # clique enviado mas ID não anotado: recupera pela IE + data de criação
                    rows = await self.legacy.read_all_rows()
                    request_id = recover_request_id(rows, client_ie, task.requested_at, claimed)
                    if request_id:
                        claimed.add(request_id)
                        await self.ctx.logger.info(
                            f"{task.task_type}: ID {request_id} recuperado pela IE e data de criação.",
                            step="checking_processing",
                        )
                if not request_id:
                    await self.ctx.logger.warning(
                        f"{task.task_type}: agendamento sem ID identificável; verifique a lista no SIAT.",
                        step="checking_processing",
                    )
                    results[task.id] = ExportStatusResult(document_type=doc, status=ExportStatus.NOT_FOUND)
                    continue
                found = await self.legacy.find_row(request_id)
                if found is None:
                    results[task.id] = ExportStatusResult(
                        document_type=doc, external_request_id=request_id, status=ExportStatus.NOT_FOUND
                    )
                    continue
                row, _ = found
                if row.ie and not ie_matches(row.ie, client_ie):
                    raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {row.ie}", security=True)
                results[task.id] = ExportStatusResult(
                    document_type=doc,
                    external_request_id=row.request_id,
                    status=classify_status(row.situacao, self.sel),
                    raw_status=row.raw[:500],
                    row_index=row.index,
                )
            await self.ctx.reporter.screenshot(f"export_list_{family}")
        return [results[t.id] for t in tasks]

    async def download(self, task: Task, status: ExportStatusResult, tmp_dir: Path) -> DownloadedFile:
        if task.document_type is None or not status.external_request_id:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, "Agendamento sem ID; não é possível baixar.")
        client_ie = self.legacy.require_ie()
        await self.ctx.reporter.step(JobStatus.DOWNLOADING, f"Baixando {task.document_type.value}")
        await self.legacy.go_to(family_of(task.document_type))
        found = await self.legacy.find_row(status.external_request_id)
        if found is None:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, f"Agendamento {status.external_request_id} não está mais na lista.")
        row, row_locator = found
        # PROTEÇÃO CONTRA CLIENTE ERRADO: a linha precisa ser da IE do cliente
        if not row.ie or not ie_matches(row.ie, client_ie):
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {row.ie or 'não informada'}", security=True)

        rx = self.sel.rx("legacy_download_button")
        button = await first_visible(
            [row_locator.get_by_role("button", name=rx), row_locator.get_by_role("link", name=rx), row_locator.get_by_text(rx)],
            5_000,
        )
        if button is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Botão 'Download' não encontrado na linha.")
        try:
            async with self.page.expect_download(timeout=self.ctx.settings.download_timeout) as info:
                await button.click()
            download = await info.value
        except PlaywrightTimeout as exc:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, "Tempo esgotado aguardando o download.") from exc
        failure = await download.failure()
        if failure:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, f"Download falhou: {failure}")

        ensure_dir(tmp_dir)
        suggested = safe_name(download.suggested_filename or f"{task.id}.zip")
        tmp_path = tmp_dir / f"{task.id}_{suggested}"
        try:
            await download.save_as(str(tmp_path))
        except PlaywrightError as exc:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, f"Não foi possível salvar o arquivo: {exc}") from exc

        await self.ctx.reporter.step(JobStatus.ORGANIZING_FILES, "Organizando arquivos")
        try:
            stored = self.ctx.organizer.store(
                tmp_path,
                self.ctx.client.client_code,
                self.ctx.job.competence,
                task.document_type,
                client_name=self.ctx.client.trade_name or self.ctx.client.legal_name,
            )
        except InvalidDownloadError as exc:
            tmp_path.unlink(missing_ok=True)
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, str(exc)) from exc
        except DownloadFolderUnavailable as exc:
            # o arquivo continua disponível no SIAT: nova tentativa mais tarde
            tmp_path.unlink(missing_ok=True)
            raise AutomationError(
                ErrorCode.DOWNLOAD_FAILED,
                f"Pasta de downloads indisponível: {exc}",
                retryable=True,
            ) from exc
        await self.ctx.logger.info(
            f"Arquivo salvo: {stored.filename} ({stored.size} bytes, sha256 {stored.checksum[:12]}…) "
            f"— agendamento {row.request_id}",
            step="downloading",
        )
        return stored
