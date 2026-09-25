"""SIAT web legado (webas.sefaz.pi.gov.br/siatweb): menus, contribuinte e listas.

Acesso: e-AGEAT -> "Autorregularização" -> "SIAT". Esse sistema (JSF) não mostra
o CNPJ: identifica o contribuinte por "Usuário: NOME" e pela Inscrição Estadual
(select "Inscrição" nos formulários e coluna "IE" nas listas de agendamentos).
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass

from playwright.async_api import Error as PlaywrightError, Locator, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import dialog_by_title, find_clickable, first_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import Client, DocumentType

NFCE = "nfce"
NFE = "nfe"


def family_of(document_type: DocumentType) -> str:
    return NFCE if document_type == DocumentType.NFCE else NFE


def only_digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def ie_matches(a: str | None, b: str | None) -> bool:
    """Compara inscrições estaduais ignorando pontuação e zeros à esquerda."""
    da, db = only_digits(a).lstrip("0"), only_digits(b).lstrip("0")
    return bool(da) and da == db


def _norm_name(text: str | None) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text).strip().upper()


@dataclass(slots=True)
class LegacyRow:
    index: int
    request_id: str
    situacao: str
    ie: str
    created: str
    processed: str
    raw: str


def parse_export_table(headers: list[str], rows: list[list[str]], sel: SiatSelectors | None = None) -> list[LegacyRow]:
    """Lê a lista "Exportação de Notas Fiscais Agendadas" / "Agendamentos de exportação NFCe"."""
    sel = sel or get_selectors()

    def idx(rx: re.Pattern[str]) -> int | None:
        return next((i for i, h in enumerate(headers) if rx.search(h.strip())), None)

    id_i = idx(sel.rx("legacy_table_id_header"))
    st_i = idx(sel.rx("legacy_table_status_header"))
    ie_i = idx(sel.rx("legacy_table_ie_header"))
    created_i = idx(re.compile(r"cria[çc][ãa]o", re.I))
    processed_i = idx(re.compile(r"processamento", re.I))

    def cell(cells: list[str], i: int | None) -> str:
        return cells[i].strip() if i is not None and i < len(cells) else ""

    parsed: list[LegacyRow] = []
    for n, cells in enumerate(rows):
        request_id = cell(cells, id_i) if id_i is not None else ""
        if not request_id or not re.search(r"\d", request_id):
            continue  # linha vazia / "nenhum registro"
        parsed.append(
            LegacyRow(
                index=n,
                request_id=request_id,
                situacao=cell(cells, st_i),
                ie=only_digits(cell(cells, ie_i)),
                created=cell(cells, created_i),
                processed=cell(cells, processed_i),
                raw=" | ".join(cells),
            )
        )
    return parsed


def new_request_ids(before: set[str], after: list[LegacyRow], client_ie: str | None) -> list[str]:
    """IDs que surgiram na lista após o agendamento (do mesmo contribuinte, se houver coluna IE)."""
    return [
        r.request_id
        for r in after
        if r.request_id not in before and (not r.ie or not client_ie or ie_matches(r.ie, client_ie))
    ]


def pick_inscricao_option(options: list[str], client_ie: str) -> str | None:
    """Opção do select "Inscrição" que corresponde exatamente à IE do cliente."""
    matches = [o for o in options if ie_matches(o, client_ie)]
    return matches[0] if len(matches) == 1 else None


class SiatLegacy:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    @property
    def client(self) -> Client:
        return self.ctx.client

    def on_legacy(self) -> bool:
        try:
            return bool(self.sel.rx("legacy_url_marker").search(self.page.url))
        except PlaywrightError:
            return False

    def require_ie(self) -> str:
        ie = only_digits(self.client.state_registration)
        if not ie:
            raise AutomationError(
                ErrorCode.INVALID_CONFIGURATION,
                "Cadastre a Inscrição Estadual do cliente: o SIAT web identifica o contribuinte pela IE.",
            )
        return ie

    # -- navegação ------------------------------------------------------------
    async def _adopt_new_tab(self, pages_before: int) -> None:
        context = self.page.context
        for _ in range(20):
            if len(context.pages) > pages_before:
                new_page = context.pages[-1]
                await new_page.wait_for_load_state("domcontentloaded")
                await new_page.bring_to_front()
                self.ctx.page = new_page
                return
            await asyncio.sleep(0.25)

    async def _menu(self, *patterns: re.Pattern[str], what: str) -> None:
        """Abre menus em cascata (clica/passa o mouse) e clica no último item."""
        for n, rx in enumerate(patterns):
            item = await find_clickable(self.page, rx, timeout_ms=10_000)
            if item is None:
                raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Menu não encontrado: {what} ({rx.pattern}).")
            await item.hover()
            if n == 0 or n == len(patterns) - 1:
                pages_before = len(self.page.context.pages)
                await item.click()
                if n == len(patterns) - 1:
                    await self._adopt_new_tab(pages_before)
            await asyncio.sleep(0.3)
        await wait_idle(self.page)

    async def open_from_eageat(self, timeout_s: float = 60) -> None:
        """e-AGEAT -> "Autorregularização" -> "SIAT" -> SIAT web legado."""
        if self.on_legacy():
            return
        await self._menu(self.sel.rx("eageat_menu_root"), self.sel.rx("eageat_menu_siat"), what="Autorregularização > SIAT")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while not self.on_legacy() and loop.time() < deadline:
            await asyncio.sleep(0.5)
        await wait_idle(self.page)
        await self.ctx.reporter.screenshot("siat_legacy_home")
        if not self.on_legacy():
            raise AutomationError(
                ErrorCode.SELECTOR_NOT_FOUND,
                f"O menu 'SIAT' do e-AGEAT não abriu o SIAT web (página: {self.page.url.split('?')[0]}).",
            )
        user = await self.logged_user()
        if not user:
            raise AutomationError(ErrorCode.LOGIN_FAILED, "O SIAT web abriu sem usuário logado.")
        await self.ctx.logger.info(f"SIAT web aberto. Usuário: {user}", step="opening_siat_module")

    async def go_to(self, family: str) -> None:
        """Autoatendimento -> NFC-e/NF-e -> Consultar/Exportar."""
        if self.ctx.state.get("legacy_page") == family:
            return
        if family == NFCE:
            patterns = (self.sel.rx("legacy_menu_root"), self.sel.rx("legacy_menu_nfce"), self.sel.rx("legacy_menu_nfce_export"))
            what = "Autoatendimento > NFC-e > Consultar/Exportar NFC-e"
        else:
            patterns = (self.sel.rx("legacy_menu_root"), self.sel.rx("legacy_menu_nfe"), self.sel.rx("legacy_menu_nfe_export"))
            what = "Autoatendimento > NF-e > Consultar/Exportar NF-e"
        await self._menu(*patterns, what=what)
        self.ctx.state["legacy_page"] = family
        await self.dismiss_notices()
        await self.ctx.reporter.screenshot(f"legacy_{family}")

    async def dismiss_notices(self) -> None:
        """Fecha avisos informativos ("Comunicado Importante" -> [Entendi]), registrando o texto."""
        for _ in range(3):
            dialog = await dialog_by_title(self.page, self.sel.rx("legacy_notice_title"), timeout_ms=2_000)
            if dialog is None:
                return
            try:
                text = re.sub(r"\s+", " ", (await dialog.inner_text()).strip())
            except PlaywrightError:
                text = ""
            button = await find_clickable(dialog, self.sel.rx("legacy_notice_button"), timeout_ms=3_000)
            if button is None:
                raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Aviso do SIAT web sem botão 'Entendi'.")
            await button.click()
            await wait_idle(self.page, 5_000)
            await self.ctx.logger.info(f"Aviso do SIAT web fechado: {text[:400]}", step="navigating_export")

    # -- contribuinte -----------------------------------------------------------
    async def logged_user(self) -> str | None:
        try:
            text = await self.page.locator("body").inner_text()
        except PlaywrightError:
            return None
        m = self.sel.rx("legacy_user_label").search(text)
        return m.group(1).strip().splitlines()[0].strip() if m else None

    async def inscricao_select(self) -> Locator | None:
        """Select "Inscrição" (pelo rótulo; senão, o select cujas opções contêm IEs)."""
        by_label = await first_visible([self.page.get_by_label(self.sel.rx("legacy_inscricao_label"))], 1_000)
        if by_label is not None:
            try:
                if await by_label.evaluate("el => el.tagName.toLowerCase()") == "select":
                    return by_label
            except PlaywrightError:
                pass
        selects = self.page.locator("select")
        for i in range(await selects.count()):
            sel = selects.nth(i)
            if not await sel.is_visible():
                continue
            options = await sel.locator("option").all_inner_texts()
            if any(len(only_digits(o)) >= 8 for o in options):
                return sel
        return None

    async def select_client_inscricao(self) -> None:
        """Seleciona exatamente a IE do cliente; qualquer divergência bloqueia."""
        ie = self.require_ie()
        select = await self.inscricao_select()
        if select is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Campo 'Inscrição' não encontrado no formulário.")
        options = [o.strip() for o in await select.locator("option").all_inner_texts()]
        chosen = pick_inscricao_option(options, ie)
        if chosen is None:
            raise TaxpayerMismatchError(
                f"IE {ie}", ", ".join(o for o in options if only_digits(o)) or "nenhuma IE", security=True
            )
        await select.select_option(label=chosen)
        await wait_idle(self.page, 5_000)

    async def verify(self) -> None:
        """Guarda de segurança no SIAT web: IE selecionada = IE do cliente."""
        ie = self.require_ie()
        user = await self.logged_user()
        if not user:
            raise TaxpayerMismatchError(f"IE {ie}", None, security=True)
        if _norm_name(user) != _norm_name(self.client.legal_name):
            await self.ctx.logger.info(
                f"Usuário do SIAT web ({user}) difere da razão social; validando pela IE.", step="security_check"
            )
        select = await self.inscricao_select()
        if select is not None:
            current = await select.evaluate("el => el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''")
            if not ie_matches(current, ie):
                raise TaxpayerMismatchError(f"IE {ie}", current or None, security=True)

    # -- listas de agendamentos ---------------------------------------------------
    async def _export_table(self) -> Locator | None:
        tables = self.page.locator("table")
        for i in range(await tables.count()):
            table = tables.nth(i)
            try:
                if not await table.is_visible():
                    continue
                headers = [h.strip() for h in await table.locator("thead th").all_inner_texts()]
            except PlaywrightError:
                continue
            if any(self.sel.rx("legacy_table_id_header").search(h) for h in headers) and any(
                self.sel.rx("legacy_table_status_header").search(h) for h in headers
            ):
                return table
        return None

    async def read_rows(self) -> tuple[list[LegacyRow], Locator | None]:
        table = await self._export_table()
        if table is None:
            return [], None
        headers = [h.strip() for h in await table.locator("thead th").all_inner_texts()]
        body_rows = table.locator("tbody tr")
        cells: list[list[str]] = []
        for i in range(await body_rows.count()):
            cells.append([c.strip() for c in await body_rows.nth(i).locator("td").all_inner_texts()])
        return parse_export_table(headers, cells, self.sel), table

    async def next_page(self) -> bool:
        nxt = self.page.locator(self.sel.legacy_paginator_next).first
        try:
            if await nxt.count() == 0 or not await nxt.is_visible():
                return False
            classes = (await nxt.get_attribute("class")) or ""
            if "disabled" in classes:
                return False
            await nxt.click()
            await wait_idle(self.page, 10_000)
            return True
        except PlaywrightError:
            return False

    async def find_row(self, request_id: str, max_pages: int = 10) -> tuple[LegacyRow, Locator] | None:
        """Procura o agendamento pelo ID, avançando páginas se necessário."""
        for _ in range(max_pages):
            rows, table = await self.read_rows()
            for r in rows:
                if r.request_id == request_id and table is not None:
                    return r, table.locator("tbody tr").nth(r.index)
            if not await self.next_page():
                return None
        return None

    async def feedback_text(self) -> str:
        loc = await first_visible(
            [
                self.page.locator(self.sel.legacy_feedback_container),
                self.page.get_by_role("alert"),
            ],
            2_000,
        )
        if loc is None:
            return ""
        try:
            return (await loc.inner_text()).strip()
        except PlaywrightError:
            return ""
