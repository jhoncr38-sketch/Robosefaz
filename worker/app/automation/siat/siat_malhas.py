"""Consulta de Malhas no SIAT web legado (Autoatendimento -> Malhas Fiscais -> Consulta de Malhas).

A página mostra a Inscrição Estadual e a Razão Social do contribuinte logado e,
depois de "Consulta", duas tabelas: DECLARAÇÃO DIEF/PGDAS e DECLARAÇÃO EFD/OIE,
com as malhas em aberto (identificação, quantidade de períodos, ICMS
devido/destacado e quantidade de NF-e) ou "Nenhum registro encontrado".

Somente leitura: o robô não abre a lupa das malhas nem altera nada. Antes de
consultar confere que a IE da página é a do cliente (nunca lê malha de outro).
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import asdict, dataclass, field

from playwright.async_api import Error as PlaywrightError, Locator, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import find_clickable, find_field, first_visible, text_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_legacy import SiatLegacy, ie_matches, only_digits
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.state_machine import JobStatus

SOURCES = ("DIEF_PGDAS", "EFD_OIE")
SOURCE_LABEL = {"DIEF_PGDAS": "DIEF/PGDAS", "EFD_OIE": "EFD/OIE"}
_HEADER_CELL = re.compile(r"identifica[çc][ãa]o", re.I)


@dataclass(slots=True)
class MalhaFinding:
    source: str  # DIEF_PGDAS | EFD_OIE
    identification: str
    periods: int | None
    icms: float | None
    nfe_count: int | None
    raw: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(slots=True)
class MalhaResult:
    state_registration: str
    legal_name: str
    findings: list[MalhaFinding] = field(default_factory=list)
    raw_text: str = ""

    @property
    def icms_total(self) -> float:
        return round(sum(f.icms or 0.0 for f in self.findings), 2)

    @property
    def nfe_total(self) -> int:
        return sum(f.nfe_count or 0 for f in self.findings)


def parse_brl(text: str | None) -> float | None:
    """"R$ 1.234,56" -> 1234.56; vazio -> None."""
    digits = re.sub(r"[^\d,.-]", "", text or "")
    if not re.search(r"\d", digits):
        return None
    if "," in digits:
        digits = digits.replace(".", "").replace(",", ".")
    try:
        return round(float(digits), 2)
    except ValueError:
        return None


def parse_int(text: str | None) -> int | None:
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else None


def format_brl(value: float | None) -> str:
    if value is None:
        return "—"
    whole, cents = f"{value:,.2f}".split(".")
    return f"R$ {whole.replace(',', '.')},{cents}"


def parse_rows(source: str, rows: list[list[str]], sel: SiatSelectors | None = None) -> list[MalhaFinding]:
    """Linhas (células de <td>) de uma das tabelas -> malhas; ignora cabeçalho e "Nenhum registro"."""
    sel = sel or get_selectors()
    empty = sel.rx("malhas_empty")
    out: list[MalhaFinding] = []
    for cells in rows:
        cells = [c.strip() for c in cells]
        joined = " | ".join(cells)
        if not joined or empty.search(joined) or len(cells) < 4 or _HEADER_CELL.search(cells[0]):
            continue
        if not cells[0]:
            continue
        out.append(
            MalhaFinding(
                source=source,
                identification=" ".join(cells[0].split()),
                periods=parse_int(cells[1]),
                icms=parse_brl(cells[2]),
                nfe_count=parse_int(cells[3]),
                raw=joined,
            )
        )
    return out


def summary(result: MalhaResult) -> str:
    """Mensagem final do job (aparece na Fila, no Histórico e na notificação)."""
    n = len(result.findings)
    if n == 0:
        return "Malhas fiscais: nenhuma malha em aberto."
    if n == 1:
        f = result.findings[0]
        parts = [f.identification]
        if f.icms is not None:
            parts.append(f"ICMS {format_brl(f.icms)}")
        if f.nfe_count is not None:
            parts.append(f"{f.nfe_count} NF-e")
        return f"Malhas fiscais: 1 malha em aberto ({SOURCE_LABEL[f.source]}): {' · '.join(parts)}."
    by_source = [
        f"{SOURCE_LABEL[s]} {sum(1 for f in result.findings if f.source == s)}"
        for s in SOURCES
        if any(f.source == s for f in result.findings)
    ]
    return f"Malhas fiscais: {n} malhas em aberto ({', '.join(by_source)}) · ICMS {format_brl(result.icms_total)}."


class SiatMalhas:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()
        self.legacy = SiatLegacy(ctx, self.sel)

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    async def _field_value(self, label_key: str) -> str:
        field_ = await find_field(self.page, self.sel.rx(label_key), timeout_ms=3_000)
        if field_ is None:
            return ""
        try:
            return (await field_.input_value()).strip()
        except PlaywrightError:
            return ""

    async def _table_for(self, source: str) -> Locator | None:
        """A tabela cujo título (dentro dela ou logo acima) é DIEF/PGDAS ou EFD/OIE."""
        rx = self.sel.rx("malhas_table_dief" if source == "DIEF_PGDAS" else "malhas_table_efd")
        anchor = self.page.get_by_text(rx).first
        try:
            if not await anchor.is_visible():
                return None
        except PlaywrightError:
            return None
        inside = anchor.locator("xpath=ancestor-or-self::table[1]")
        if await inside.count():
            return inside.first
        following = anchor.locator("xpath=following::table[1]")
        return following.first if await following.count() else None

    @staticmethod
    async def _rows(table: Locator) -> list[list[str]]:
        rows: list[list[str]] = []
        trs = table.locator("tr")
        for i in range(await trs.count()):
            rows.append(await trs.nth(i).locator("td").all_inner_texts())  # cabeçalhos (th) ficam vazios
        return rows

    async def _validate_ie(self, ie_field: Locator) -> str:
        """Clica no ✔ ao lado da IE e espera o SIAT preencher a razão social. -> razão social."""
        icon = await first_visible(
            [
                self.page.get_by_title(self.sel.rx("malhas_validate_icon")),
                self.page.get_by_role("link", name=self.sel.rx("malhas_validate_icon")),
                self.page.get_by_role("button", name=self.sel.rx("malhas_validate_icon")),
                ie_field.locator("xpath=following::*[self::a or self::button][1]"),
                ie_field.locator("xpath=following::img[1]"),
            ],
            3_000,
        )
        if icon is None:
            await ie_field.press("Enter")
        else:
            await icon.click()
        await wait_idle(self.page)
        for _ in range(20):  # o SIAT preenche a razão social por AJAX
            name = await self._field_value("malhas_name_label")
            if name:
                return name
            await asyncio.sleep(0.5)
        return ""

    async def _click_consult(self) -> None:
        button = await find_clickable(self.page, self.sel.rx("malhas_consult_button"), timeout_ms=10_000)
        if button is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Botão 'Consulta' das malhas não encontrado.")
        await button.click()
        await wait_idle(self.page)

    async def _wait_tables(self, timeout_s: float = 15) -> None:
        """As tabelas chegam por AJAX depois do 'Consulta'."""
        rx = self.sel.rx("malhas_table_dief")
        for _ in range(int(timeout_s * 2)):
            try:
                if await self.page.get_by_text(rx).first.is_visible():
                    return
            except PlaywrightError:
                pass
            await asyncio.sleep(0.5)

    async def consult(self) -> MalhaResult:
        await self.ctx.reporter.step(JobStatus.CHECKING_PROCESSING, "Consultando malhas fiscais")
        client_ie = self.legacy.require_ie()
        await self.legacy.go_to_malhas()

        ie_field = await find_field(self.page, self.sel.rx("malhas_ie_label"), timeout_ms=10_000)
        if ie_field is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Campo 'Inscrição Estadual' da Consulta de Malhas não encontrado.")
        current = only_digits(await ie_field.input_value())
        # PROTEÇÃO CONTRA CLIENTE ERRADO: a IE que o SIAT mostra precisa ser a do cliente
        if current and not ie_matches(current, client_ie):
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {current}", security=True)
        if not current:
            await ie_field.fill(client_ie)
        legal_name = await self._field_value("malhas_name_label")
        if not legal_name:
            # página abriu sem a IE (ex.: certificado de contador): o SIAT só aceita a consulta
            # depois de validar a inscrição pelo ✔ ao lado do campo, que preenche a razão social
            legal_name = await self._validate_ie(ie_field)

        await self._click_consult()
        if await text_visible(self.page, self.sel.rx("malhas_validate_error"), timeout_ms=1_500):
            await self.ctx.logger.info("O SIAT pediu para validar a inscrição estadual; validando.", step="checking_processing")
            legal_name = await self._validate_ie(ie_field)
            await self._click_consult()
        await self._wait_tables()
        await self.ctx.reporter.screenshot("malhas_result")

        findings: list[MalhaFinding] = []
        texts = [f"Inscrição Estadual: {current or client_ie}", f"Razão Social: {legal_name}"]
        found_tables = 0
        for source in SOURCES:
            table = await self._table_for(source)
            if table is None:
                continue
            found_tables += 1
            findings += parse_rows(source, await self._rows(table), self.sel)
            texts.append(" ".join((await table.inner_text()).split("\t")))
        if found_tables == 0:
            raise AutomationError(
                ErrorCode.SELECTOR_NOT_FOUND, "As tabelas da Consulta de Malhas (DIEF/PGDAS e EFD/OIE) não apareceram."
            )
        await self.ctx.logger.info(
            f"Consulta de Malhas lida: {len(findings)} malha(s) em {found_tables} tabela(s).", step="checking_processing"
        )
        return MalhaResult(
            state_registration=current or client_ie, legal_name=legal_name, findings=findings, raw_text="\n\n".join(texts)
        )
