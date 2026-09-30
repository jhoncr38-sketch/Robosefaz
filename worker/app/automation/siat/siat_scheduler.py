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

import asyncio
import re
from datetime import date, datetime, timezone
from typing import Awaitable, Callable, Literal

from playwright.async_api import Error as PlaywrightError, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import dialog_by_title, fill_field, find_clickable, first_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_legacy import (
    NFCE,
    SiatLegacy,
    family_of,
    ie_matches,
    new_request_ids,
    pick_new_request_id,
)
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
    # "Já existe um agendamento ... busque o ID: 9240745": o ID vem no fim da frase
    m = sel.rx("export_existing_id_regex").search(text)
    if m:
        return m.group(1)
    # várias palavras-chave podem aparecer ("agendamento com ..."): vale o 1º valor com dígito
    for m in sel.rx("export_protocol_regex").finditer(text):
        value = m.group(1).strip().strip(".-")
        if re.fullmatch(r"\d{2}/\d{2}/\d{4}", value) or not re.search(r"\d", value):
            continue
        return value
    return None


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

    async def _choose_in_group(self, group: re.Pattern[str], option: re.Pattern[str], what: str) -> None:
        """Marca a opção DENTRO da linha do grupo (ex.: "Todas" de "Status" e não de "Tipo de nota")."""
        label = await first_visible([self.page.get_by_text(group)], 10_000)
        if label is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Grupo não encontrado: {what} ({group.pattern}).")
        row = label.locator("xpath=ancestor::tr[1]")
        scope = row if await row.count() else label.locator("xpath=..")
        target = await first_visible([scope.get_by_label(option), scope.get_by_text(option)], 5_000)
        if target is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"Opção não encontrada: {what} ({option.pattern}).")
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
            tipo, status = "saida", self.ctx.settings.nfce_status
        else:
            tipo, status = self.ctx.settings.nfe_tipo_nota, self.ctx.settings.nfe_status
        await self._choose_in_group(
            self.sel.rx("legacy_group_tipo_nota"), self.sel.rx(f"legacy_tipo_nota_{tipo}"), f"Tipo de nota: {tipo}"
        )
        await self._choose_in_group(
            self.sel.rx("legacy_group_status"), self.sel.rx(f"legacy_status_{status}"), f"Status: {status}"
        )
        await fill_field(self.page, self.sel.rx("legacy_date_start_label"), format_br_date(start_date), what="Data inicial")
        await fill_field(self.page, self.sel.rx("legacy_date_end_label"), format_br_date(end_date), what="Data final")

    async def _check_existing(self, request_id: str, client_ie: str) -> None:
        """Agendamento já existente informado pelo SIAT: confere a IE da linha, se ela estiver na lista."""
        found = await self.legacy.find_row(request_id)
        if found is None:
            await self.ctx.logger.warning(
                f"SIAT informou agendamento já existente (ID {request_id}); a linha não foi localizada na lista.",
                step="scheduling",
            )
            return
        row, _ = found
        if row.ie and not ie_matches(row.ie, client_ie):
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {row.ie}", security=True)
        await self.ctx.logger.info(
            f"Agendamento já existia no SIAT: reaproveitando o ID {request_id} ({row.situacao}).", step="scheduling"
        )

    async def _delete_existing(self, request_id: str, client_ie: str) -> bool:
        """Forçar reagendamento: exclui no SIAT o agendamento que ele disse já existir.

        Só o ID informado pelo próprio SIAT, só se a linha for da IE do cliente.
        Devolve False (sem excluir nada) quando a linha não é encontrada.
        """
        found = await self.legacy.find_row(request_id)
        if found is None:
            await self.ctx.logger.warning(
                f"Forçar reagendamento: agendamento {request_id} não localizado na lista; nada foi excluído.",
                step="scheduling",
            )
            return False
        row, row_locator = found
        # PROTEÇÃO CONTRA CLIENTE ERRADO: nunca excluir agendamento de outra inscrição
        if not row.ie or not ie_matches(row.ie, client_ie):
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {row.ie or 'não informada'}", security=True)
        rx = self.sel.rx("legacy_delete_button")
        button = await first_visible(
            [row_locator.get_by_role("button", name=rx), row_locator.get_by_role("link", name=rx), row_locator.get_by_text(rx)],
            5_000,
        )
        if button is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Botão 'Excluir' não encontrado na linha do agendamento.")
        await button.click()
        dialog = await dialog_by_title(self.page, self.sel.rx("legacy_delete_confirm_title"), timeout_ms=10_000)
        if dialog is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Confirmação de exclusão do agendamento não apareceu.")
        yes = await first_visible(
            [dialog.get_by_role("button", name=self.sel.rx("legacy_delete_confirm_yes")), dialog.get_by_text(self.sel.rx("legacy_delete_confirm_yes"))],
            5_000,
        )
        if yes is None:
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Botão 'Sim' da exclusão não encontrado.")
        await yes.click()
        await wait_idle(self.page, 20_000)
        if not await self._row_gone(request_id):
            raise AutomationError(
                ErrorCode.SCHEDULE_FAILED,
                f"O agendamento {request_id} continua na lista depois da exclusão.",
                retryable=False,
            )
        await self.ctx.logger.info(
            f"Forçar reagendamento: agendamento {request_id} ({row.situacao}) excluído no SIAT; pedindo um novo.",
            step="scheduling",
        )
        await self.ctx.reporter.screenshot(f"deleted_{request_id}")
        return True

    async def _row_gone(self, request_id: str, timeout_s: float = 20) -> bool:
        """Depois do "Sim" o SIAT atualiza a lista por AJAX, às vezes com atraso: espera a linha sumir.

        Conferir cedo demais dava "continua na lista" com a exclusão já feita (e o pedido novo
        nunca era enviado).
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while True:
            if await self.legacy.find_row(request_id) is None:
                return True
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(1)

    async def schedule(
        self,
        document_type: DocumentType,
        start_date: date,
        end_date: date,
        competence: str,
        replaced: str | None = None,
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
            + (
                f", tipo saída, status {self.ctx.settings.nfce_status}"
                if family == NFCE
                else f", tipo {self.ctx.settings.nfe_tipo_nota}, status {self.ctx.settings.nfe_status}"
            ),
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
        if self.ctx.on_submit is not None:
            await self.ctx.on_submit()
        submitted_at = datetime.now(timezone.utc)
        await button.click()
        await wait_idle(self.page, 20_000)

        message = await self.legacy.feedback_text()
        kind = classify_message(message, self.sel)
        await self.ctx.logger.info(f"Retorno do SIAT: {message or '(sem mensagem)'}", step="scheduling")
        await self.ctx.reporter.screenshot(f"result_{document_type.value}")
        if kind in ("duplicate", "error") and self.ctx.on_rejected is not None:
            # o SIAT NÃO criou pedido novo: a tarefa deixa de constar como enviada (senão, se algo
            # falhar daqui para a frente, ela fica "agendada" sem pedido e o Reprocessar não a refaz)
            await self.ctx.on_rejected()
        if kind == "error":
            raise AutomationError(ErrorCode.SCHEDULE_FAILED, f"SIAT recusou o agendamento: {message}", retryable=False)

        after_rows, _ = await self.legacy.read_rows()
        client_ie = self.legacy.require_ie()
        # PROTEÇÃO CONTRA CLIENTE ERRADO: agendamento novo com IE de outro contribuinte
        foreign = [r for r in after_rows if r.request_id not in before and r.ie and not ie_matches(r.ie, client_ie)]
        if foreign:
            raise TaxpayerMismatchError(f"IE {client_ie}", f"IE {foreign[0].ie}", security=True)
        new_ids = new_request_ids(before, after_rows, client_ie)
        claimed: set[str] = self.ctx.state.setdefault("claimed_request_ids", set())
        if kind == "duplicate":
            request_id = new_ids[0] if len(new_ids) == 1 else extract_protocol(message, self.sel)
        else:
            # NF-e: a mensagem não traz o ID ("Você é numero 3 da fila") e a lista é paginada
            request_id = pick_new_request_id(before, after_rows, client_ie, submitted_at, claimed)
            request_id = request_id or extract_protocol(message, self.sel)
            if request_id and len(new_ids) != 1:
                await self.ctx.logger.info(
                    f"ID do pedido identificado pela data de criação: {request_id}.", step="scheduling"
                )
        if kind == "duplicate" and request_id is not None:
            # Forçar reagendamento: exclui o existente e pede de novo (uma única vez por tarefa)
            if self.ctx.job.force_reschedule and replaced is None:
                if await self._delete_existing(request_id, client_ie):
                    return await self.schedule(document_type, start_date, end_date, competence, replaced=request_id)
            elif replaced is not None:
                await self.ctx.logger.warning(
                    f"O SIAT recusou o novo pedido mesmo após excluir o {replaced}; aproveitando o ID {request_id}.",
                    step="scheduling",
                )
            await self._check_existing(request_id, client_ie)
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
        if request_id:
            claimed.add(request_id)
        return ExportRequestResult(
            document_type=document_type,
            external_request_id=request_id,
            requested_at=datetime.now(timezone.utc),
            dry_run=False,
            raw_message=("JA_EXISTENTE_NO_PORTAL: " if kind == "duplicate" else "")
            + (f"SUBSTITUIU {replaced}: " if replaced else "")
            + (message or ""),
        )
