"""Seleção e validação do contribuinte no SIAT.

REGRA CRÍTICA: nenhuma operação (agendar, baixar, alterar) acontece sem
confirmar que o contribuinte aberto no portal é o CNPJ do job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from playwright.async_api import Error as PlaywrightError, Locator, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import (
    dialog_by_title,
    find_clickable,
    find_field,
    first_visible,
    header_texts,
    row_cells,
    table_rows,
    wait_idle,
)
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import Client
from app.jobs.state_machine import JobStatus
from app.utils.cnpj import extract_cnpjs, format_cnpj, normalize_cnpj


@dataclass(slots=True)
class TaxpayerRow:
    index: int
    document: str
    state_registration: str
    name: str
    raw: str


def parse_taxpayer_rows(headers: list[str], rows: list[list[str]], sel: SiatSelectors | None = None) -> list[TaxpayerRow]:
    sel = sel or get_selectors()
    doc_rx = sel.rx("taxpayer_header_document")
    ie_rx = re.compile(r"inscri", re.I)
    name_rx = re.compile(r"nome|raz[ãa]o", re.I)
    doc_idx = next((i for i, h in enumerate(headers) if doc_rx.search(h)), None)
    ie_idx = next((i for i, h in enumerate(headers) if ie_rx.search(h)), None)
    name_idx = next((i for i, h in enumerate(headers) if name_rx.search(h)), None)
    parsed: list[TaxpayerRow] = []
    for i, cells in enumerate(rows):
        raw = " | ".join(cells)
        if doc_idx is not None and doc_idx < len(cells):
            document = normalize_cnpj(cells[doc_idx])
        else:
            found = extract_cnpjs(raw)
            document = found[0] if found else ""
        parsed.append(
            TaxpayerRow(
                index=i,
                document=document,
                state_registration=re.sub(r"\D", "", cells[ie_idx]) if ie_idx is not None and ie_idx < len(cells) else "",
                name=cells[name_idx] if name_idx is not None and name_idx < len(cells) else "",
                raw=raw,
            )
        )
    return parsed


def choose_taxpayer_row(rows: list[TaxpayerRow], client: Client) -> TaxpayerRow:
    """Escolhe exatamente o contribuinte do cliente; qualquer dúvida = erro."""
    cnpj = normalize_cnpj(client.cnpj)
    matches = [r for r in rows if r.document == cnpj]
    ie = re.sub(r"\D", "", client.state_registration or "")
    if len(matches) > 1 and ie:
        matches = [r for r in matches if r.state_registration == ie]
    if not matches:
        found = rows[0].document if rows else None
        raise TaxpayerMismatchError(format_cnpj(cnpj), format_cnpj(found) if found else None)
    if len(matches) > 1:
        raise AutomationError(
            ErrorCode.TAXPAYER_MISMATCH,
            "Mais de um contribuinte com o mesmo CNPJ; informe a inscrição estadual no cadastro do cliente.",
        )
    return matches[0]


def validate_current_taxpayer(page_documents: list[str], client: Client, *, security: bool) -> None:
    cnpj = normalize_cnpj(client.cnpj)
    if cnpj in page_documents:
        return
    found = page_documents[0] if page_documents else None
    raise TaxpayerMismatchError(format_cnpj(cnpj), format_cnpj(found) if found else None, security=security)


class SiatTaxpayer:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    async def current_documents(self) -> list[str]:
        texts: list[str] = []
        try:
            containers = self.page.locator(self.sel.current_taxpayer_container)
            count = await containers.count()
            for i in range(min(count, 20)):
                item = containers.nth(i)
                if await item.is_visible():
                    texts.append(await item.inner_text())
        except PlaywrightError:
            pass
        docs: list[str] = []
        for t in texts:
            for d in extract_cnpjs(t):
                if d not in docs:
                    docs.append(d)
        return docs

    async def verify(self, *, security: bool = True) -> None:
        """Guarda de segurança; security=True gera SECURITY_CLIENT_MISMATCH."""
        docs = await self.current_documents()
        if normalize_cnpj(self.ctx.client.cnpj) not in docs and not docs:
            # só para a mensagem de erro dizer QUEM abriu; a decisão continua sendo "não confirmado"
            try:
                body = await self.page.locator("body").inner_text(timeout=3_000)
            except PlaywrightError:
                body = ""
            seen = [d for d in extract_cnpjs(body) if d != normalize_cnpj(self.ctx.client.cnpj)]
            raise TaxpayerMismatchError(
                format_cnpj(self.ctx.client.cnpj), format_cnpj(seen[0]) if seen else None, security=security
            )
        validate_current_taxpayer(docs, self.ctx.client, security=security)
        await self.ctx.logger.debug(
            f"Contribuinte confirmado: {format_cnpj(self.ctx.client.cnpj)}", step="security_check"
        )

    async def _open_dialog(self) -> Locator | None:
        dialog = await dialog_by_title(self.page, self.sel.rx("taxpayer_dialog_title"), timeout_ms=3_000)
        if dialog is not None:
            return dialog
        btn = await find_clickable(self.page, self.sel.rx("taxpayer_open_button"), timeout_ms=3_000)
        if btn is None:
            return None
        await btn.click()
        await wait_idle(self.page)
        return await dialog_by_title(self.page, self.sel.rx("taxpayer_dialog_title"), timeout_ms=10_000)

    async def select(self) -> None:
        await self.ctx.reporter.step(JobStatus.SELECTING_TAXPAYER, "Selecionando contribuinte")
        client = self.ctx.client

        if normalize_cnpj(client.cnpj) in await self.current_documents():
            await self.ctx.logger.info("Contribuinte já selecionado no portal.", step="selecting_taxpayer")
            return

        dialog = await self._open_dialog()
        if dialog is None:
            # Sem tela de seleção: o login precisa ter aberto o próprio contribuinte.
            await self.verify(security=False)
            return

        field = await find_field(dialog, self.sel.rx("taxpayer_filter_document_label"), timeout_ms=3_000)
        if field is not None:
            await field.fill(normalize_cnpj(client.cnpj))
            search = await find_clickable(dialog, self.sel.rx("taxpayer_search_button"), timeout_ms=3_000)
            if search is not None:
                await search.click()
            else:
                await field.press("Enter")
            await wait_idle(self.page)

        headers = await header_texts(dialog)
        rows = await table_rows(dialog)
        parsed = parse_taxpayer_rows(headers, [await row_cells(r) for r in rows], self.sel)
        chosen = choose_taxpayer_row(parsed, client)
        row = rows[chosen.index]
        await self.ctx.logger.info(
            f"Contribuinte localizado: {format_cnpj(chosen.document)} {chosen.name}", step="selecting_taxpayer"
        )

        action = await first_visible(
            [
                row.get_by_title(self.sel.rx("taxpayer_select_action")),
                row.get_by_role("button", name=self.sel.rx("taxpayer_select_action")),
                row.locator("td").last.locator("button, i, .v-icon"),
            ],
            5_000,
        )
        if action is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Ação 'selecionar' do contribuinte não encontrada.")
        await action.click()
        await wait_idle(self.page)
        await self.ctx.reporter.screenshot("taxpayer_selected")
        await self.verify(security=False)
