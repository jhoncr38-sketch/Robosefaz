"""Agendamento de exportação no SIAT web legado (NFC-e e NF-e).

NFC-e: "Consultar NFCE" -> Contribuinte como Emitente, Inscrição, Tipo de nota
       Saída, Status (Ativas/Canceladas/Todas), Data de Emissão Inicial/Final
       -> [Agendar exportação]; lista "Agendamentos de exportação NFCe".
NF-e:  "Consultar NFE" -> Contribuinte como Emitente | como Destinatário,
       Inscrição, datas -> [Agendar exportação]; lista "Exportação de Notas
       Fiscais Agendadas" (ID, Situação, Data de criação, CNPJ, IE, ...).

A lista não mostra período nem tipo: o agendamento é identificado pelo ID que
surge na lista logo após o clique (comparação antes/depois).
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Awaitable, Callable, Literal

from playwright.async_api import Error as PlaywrightError, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import fill_field, find_clickable, first_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_legacy import NFCE, SiatLegacy, family_of, ie_matches, new_request_ids
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import DocumentType, ExportRequestResult
from app.utils.competence import format_br_date

MessageKind = Literal["success", "duplicate", "error", "unknown"]


def classify_message(text: str, sel: SiatSelectors | None = None) -> MessageKind:
    sel = sel or get_selectors()
    if not text:
        return "unknown"
    if sel.rx("export_duplicate_message").search(text):
        return "duplicate"
    if sel.rx("export_error_message").search(text):
        return "error"
    if sel.rx("export_success_message").search(text):
        return "success"
    return "unknown"


def extract_protocol(text: str, sel: SiatSelectors | None = None) -> str | None:
    sel = sel or get_selectors()
    if not text:
        return None
    m = sel.rx("export_protocol_regex").search(text)
    if not m:
        return None
    value = m.group(1).strip().strip(".-")
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}", value) or not re.search(r"\d", value):
        return None
    return value


class SiatExportScheduler:
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

    async def _choose(self, rx: re.Pattern[str], what: str) -> None:
        """Marca um radio pelo rótulo (JSF/PrimeFaces)."""
        target = await first_visible([self.page.get_by_label(rx), self.page.get_by_text(rx)], 10_000)
        if target is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Opção não encontrada: {what} ({rx.pattern}).")
        try:
            await target.check(timeout=5_000)
        except PlaywrightError:
            await target.click()
        await wait_idle(self.page, 10_000)

    async def _fill_form(self, document_type: DocumentType, start_date: date, end_date: date) -> None:
        role = "legacy_radio_destinatario" if document_type == DocumentType.NFE_RECEBIDAS else "legacy_radio_emitente"
        await self._choose(self.sel.rx(role), "Tipo de consulta (Emitente/Destinatário)")
        await self.legacy.select_client_inscricao()
        if document_type == DocumentType.NFCE:
            await self._choose(self.sel.rx("legacy_tipo_nota_saida"), "Tipo de nota: Saída")
            status_key = f"legacy_status_{self.ctx.settings.nfce_status}"
            await self._choose(self.sel.rx(status_key), f"Status da NFC-e: {self.ctx.settings.nfce_status}")
        await fill_field(self.page, self.sel.rx("legacy_date_start_label"), format_br_date(start_date), what="Data inicial")
        await fill_field(self.page, self.sel.rx("legacy_date_end_label"), format_br_date(end_date), what="Data final")

    async def schedule(
        self, document_type: DocumentType, start_date: date, end_date: date, competence: str
    ) -> ExportRequestResult:
        family = family_of(document_type)
        await self.legacy.go_to(family)
        await self.legacy.dismiss_notices()
        await self._fill_form(document_type, start_date, end_date)
        # PROTEÇÃO CONTRA CLIENTE ERRADO: IE selecionada = IE do cliente
        await self._security_check()
        await self.ctx.logger.info(
            f"Formulário preenchido: {document_type.value}, IE {self.legacy.require_ie()}, "
            f"{format_br_date(start_date)} a {format_br_date(end_date)}"
            + (f", status {self.ctx.settings.nfce_status}" if family == NFCE else ""),
            step="scheduling",
            metadata={"document_type": document_type.value, "competence": competence},
        )
        await self.ctx.reporter.screenshot(f"form_{document_type.value}")

        if self.ctx.dry_run:
            await self.ctx.logger.warning(
                "AUTOMATION_DRY_RUN ativo: botão 'Agendar exportação' NÃO foi clicado.", step="scheduling"
            )
            return ExportRequestResult(
                document_type=document_type,
                requested_at=datetime.now(timezone.utc),
                dry_run=True,
                raw_message="dry-run",
            )

        before_rows, _ = await self.legacy.read_rows()
        before = {r.request_id for r in before_rows}
        await self._security_check()
        button = await find_clickable(self.page, self.sel.rx("legacy_schedule_button"), timeout_ms=10_000)
        if button is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Botão 'Agendar exportação' não encontrado.")
        await button.click()
        await wait_idle(self.page, 20_000)

        message = await self.legacy.feedback_text()
        kind = classify_message(message, self.sel)
        await self.ctx.logger.info(f"Retorno do SIAT: {message or '(sem mensagem)'}", step="scheduling")
        await self.ctx.reporter.screenshot(f"result_{document_type.value}")
        if kind == "error":
            raise AutomationError(ErrorCode.SCHEDULE_FAILED, f"SIAT recusou o agendamento: {message}", retryable=False)

        after_rows, _ = await self.legacy.read_rows()
        client_ie = self.legacy.require_ie()
        # PROTEÇÃO CONTRA CLIENTE ERRADO: agendamento novo com IE de outro contribuinte
        foreign = [r for r in after_rows if r.request_id not in before and r.ie and not ie_matches(r.ie, client_ie)]
        if foreign:
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {foreign[0].ie}", security=True)
        new_ids = new_request_ids(before, after_rows, client_ie)
        request_id = new_ids[0] if len(new_ids) == 1 else extract_protocol(message, self.sel)
        if request_id is None:
            if kind != "success":
                raise AutomationError(
                    ErrorCode.SCHEDULE_FAILED,
                    "Não foi possível confirmar o agendamento (nenhum ID novo na lista). Verifique no portal.",
                    retryable=False,
                )
            await self.ctx.logger.warning(
                f"Agendamento confirmado pela mensagem, mas o ID não foi identificado (novos: {new_ids}).",
                step="scheduling",
            )
        return ExportRequestResult(
            document_type=document_type,
            external_request_id=request_id,
            requested_at=datetime.now(timezone.utc),
            dry_run=False,
            raw_message=("JA_EXISTENTE_NO_PORTAL: " if kind == "duplicate" else "") + (message or ""),
        )
