"""Domicílio Tributário Eletrônico (DT-e) no e-AGEAT: leitura das notificações da EFD.

Caminho (confirmado com o usuário em 27/09/2026):
  e-AGEAT (eageat/jsp/login/bemVindo.jsf) -> menu "Domicílio Eletrônico"
  -> "Mensagens do Domicílio Tributário Eletrônico (DT-e)" - Caixa de Entrada
  -> tabela: Status | Situação da Ciência | Tipo | Inscrição - Destinatário | Remetente |
     Data da Emissão | Assunto | Data da Leitura | Data da Ciência | Visualizável até | Operações
  -> lupa (Operações) abre "Detalhes da Mensagem"; botão "Fechar".

Regras de segurança:
- só abre mensagens com assunto "EPE - EFD - Período AAAAMM - <EPE>" da competência pedida
  e do tipo NOTIFICAÇÃO (intimações e outras mensagens nunca são abertas);
- nunca clica em nada que pareça excluir/arquivar (o ✖ da coluna Operações);
- confirmações do navegador ("deseja excluir?") são sempre recusadas;
- a inscrição do destinatário precisa ser a do cliente do job.

Abrir a mensagem registra a "Data de Leitura" no SIAT (o mesmo que abrir à mão);
a ciência é outra coluna e não é alterada.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime

from playwright.async_api import Dialog, Locator, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import (
    click_by_text,
    dialog_by_title,
    find_clickable,
    find_field,
    first_visible,
    header_texts,
    row_cells,
    table_rows,
    text_visible,
    wait_idle,
)
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.efd.parser import BRT, parse_subject
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.state_machine import JobStatus

MAX_PAGES = 5


@dataclass
class DteMessage:
    subject: str
    text: str
    sent_at: datetime | None = None


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def _sent_at(value: str) -> datetime | None:
    m = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}:\d{2})", value or "")
    if not m:
        return None
    try:
        return datetime.strptime(f"{m.group(1)} {m.group(2)}", "%d/%m/%Y %H:%M").replace(tzinfo=BRT)
    except ValueError:
        return None


class SiatDte:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    # -- navegação ---------------------------------------------------------------
    async def open_inbox(self) -> None:
        await self.ctx.reporter.step(JobStatus.CHECKING_PROCESSING, "Abrindo o Domicílio Eletrônico (DT-e)")
        if await text_visible(self.page, self.sel.rx("dte_page_marker")):
            return
        await click_by_text(self.page, self.sel.rx("dte_menu_root"), what="menu Domicílio Eletrônico")
        await asyncio.sleep(0.5)
        item = await find_clickable(self.page, self.sel.rx("dte_menu_inbox"), timeout_ms=5_000)
        if item is not None:
            pages_before = len(self.page.context.pages)
            await item.click()
            await self._adopt_new_tab(pages_before)
        await wait_idle(self.page)
        if not await text_visible(self.page, self.sel.rx("dte_page_marker"), timeout_ms=15_000):
            await self.ctx.reporter.screenshot("dte_inbox_not_found")
            raise AutomationError(
                ErrorCode.SELECTOR_NOT_FOUND,
                "A caixa de entrada do Domicílio Eletrônico (DT-e) não abriu.",
            )
        await self.ctx.reporter.screenshot("dte_inbox")
        await self.ctx.logger.info("Caixa de entrada do DT-e aberta.", step="checking_processing")

    async def _adopt_new_tab(self, pages_before: int) -> None:
        context = self.page.context
        for _ in range(8):
            if len(context.pages) > pages_before:
                new_page = context.pages[-1]
                await new_page.wait_for_load_state("domcontentloaded")
                await new_page.bring_to_front()
                self.ctx.page = new_page
                return
            await asyncio.sleep(0.25)

    async def _choose(self, label: re.Pattern[str], pick) -> str | None:  # noqa: ANN001
        """Escolhe uma opção de <select> identificado pelo rótulo (sem erro se não existir)."""
        field = await find_field(self.page, label, timeout_ms=2_000)
        if field is None:
            return None
        try:
            if await field.evaluate("el => el.tagName.toLowerCase()") != "select":
                return None
            options = [o.strip() for o in await field.locator("option").all_inner_texts()]
            choice = pick(options)
            if choice is None:
                return None
            await field.select_option(label=choice)
            await wait_idle(self.page)
            return choice
        except Exception:  # noqa: BLE001 - filtro é conveniência, não requisito
            return None

    async def _prepare_list(self, competence: str) -> None:
        all_rx = self.sel.rx("dte_list_all")
        listed = await self._choose(self.sel.rx("dte_list_label"), lambda opts: next((o for o in opts if all_rx.search(o)), None))

        def largest(opts: list[str]) -> str | None:
            nums = [(int(o), o) for o in opts if o.isdigit()]
            return max(nums)[1] if nums else None

        size = await self._choose(self.sel.rx("dte_page_size_label"), largest)
        await self.ctx.logger.debug(
            f"DT-e: listar={listed or 'padrão'}, visualizar={size or 'padrão'}.", step="checking_processing"
        )
        search = await find_field(self.page, self.sel.rx("dte_search_label"), timeout_ms=2_000)
        if search is not None:
            year, month = competence.split("-")
            await search.fill(f"{year}{month}")
            await search.press("Enter")
            await wait_idle(self.page)
            await asyncio.sleep(0.5)

    # -- leitura -----------------------------------------------------------------
    async def read_efd(self, competence: str) -> list[DteMessage]:
        """Abre e lê as notificações "EPE - EFD" da competência (AAAA-MM)."""

        async def refuse(dialog: Dialog) -> None:
            await dialog.dismiss()

        def on_dialog(dialog: Dialog) -> None:
            # nunca confirma nada (ex.: "deseja excluir a mensagem?")
            asyncio.ensure_future(refuse(dialog))

        self.page.on("dialog", on_dialog)
        try:
            await self.open_inbox()
            await self._prepare_list(competence)
            return await self._read_pages(competence)
        finally:
            try:
                self.page.remove_listener("dialog", on_dialog)
            except Exception:  # noqa: BLE001
                pass

    async def _read_pages(self, competence: str) -> list[DteMessage]:
        found: list[DteMessage] = []
        seen: set[str] = set()
        for page_no in range(1, MAX_PAGES + 1):
            new_on_page = await self._read_visible(competence, found, seen)
            await self.ctx.logger.debug(
                f"DT-e página {page_no}: {new_on_page} mensagem(ns) da EFD {competence} lida(s).", step="checking_processing"
            )
            nxt = await find_clickable(self.page, self.sel.rx("dte_next_page"), timeout_ms=500)
            if nxt is None:
                break
            try:
                if await nxt.is_disabled() or "disabled" in ((await nxt.get_attribute("class")) or ""):
                    break
            except Exception:  # noqa: BLE001
                break
            await nxt.click()
            await wait_idle(self.page)
        return found

    async def _column(self, headers: list[str], name: str) -> int | None:
        rx = self.sel.rx(name)
        return next((i for i, h in enumerate(headers) if rx.search(h)), None)

    async def _read_visible(self, competence: str, found: list[DteMessage], seen: set[str]) -> int:
        headers = await header_texts(self.page)
        subj_i = await self._column(headers, "dte_subject_header")
        type_i = await self._column(headers, "dte_type_header")
        sent_i = await self._column(headers, "dte_sent_header")
        recip_i = await self._column(headers, "dte_recipient_header")
        client_ie = _digits(self.ctx.client.state_registration or "")
        new = 0

        for row in await table_rows(self.page):
            cells = await row_cells(row)
            if not cells:
                continue
            subject = cells[subj_i] if subj_i is not None and subj_i < len(cells) else " | ".join(cells)
            parsed = parse_subject(subject)
            if parsed is None or parsed[0] != competence:
                continue
            epe = parsed[1]
            if epe in seen:
                continue
            if type_i is not None and type_i < len(cells) and not self.sel.rx("dte_allowed_type").search(cells[type_i]):
                await self.ctx.logger.warning(
                    f"Mensagem {epe} ignorada: tipo '{cells[type_i]}' não é notificação.", step="checking_processing"
                )
                continue
            if client_ie and recip_i is not None and recip_i < len(cells):
                recipient = _digits(cells[recip_i].split("-")[0])
                if recipient and recipient != client_ie:
                    raise AutomationError(
                        ErrorCode.SECURITY_CLIENT_MISMATCH,
                        f"A caixa do DT-e é de outra inscrição ({recipient}); esperado {client_ie}.",
                    )

            text = await self._open_and_read(row, epe)
            seen.add(epe)
            sent = cells[sent_i] if sent_i is not None and sent_i < len(cells) else ""
            found.append(DteMessage(subject=subject.strip(), text=text, sent_at=_sent_at(sent)))
            new += 1
        return new

    async def _view_button(self, row: Locator) -> Locator:
        view_rx = self.sel.rx("dte_view_button")
        danger = self.sel.rx("dte_danger")
        candidates = [
            row.get_by_role("button", name=view_rx),
            row.get_by_role("link", name=view_rx),
            row.get_by_title(view_rx),
            row.locator("a, button, input[type='button'], input[type='image']").filter(
                has=self.page.locator(self.sel.dte_view_icon_container)
            ),
        ]
        for cand in candidates:
            try:
                count = await cand.count()
            except Exception:  # noqa: BLE001
                continue
            for i in range(min(count, 5)):
                btn = cand.nth(i)
                try:
                    if not await btn.is_visible():
                        continue
                    html = await btn.evaluate("el => el.outerHTML")
                except Exception:  # noqa: BLE001
                    continue
                if danger.search(html):
                    continue
                return btn
        raise AutomationError(
            ErrorCode.SELECTOR_NOT_FOUND,
            "Botão para abrir a mensagem (lupa) não encontrado na linha do DT-e.",
        )

    async def _open_and_read(self, row: Locator, epe: str) -> str:
        btn = await self._view_button(row)
        await btn.click()
        dialog = await dialog_by_title(self.page, self.sel.rx("dte_dialog_title"), timeout_ms=15_000)
        if dialog is None:
            await self.ctx.reporter.screenshot(f"dte_msg_{epe}_not_opened")
            raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, f"A mensagem {epe} não abriu (Detalhes da Mensagem).")
        # o texto chega depois da janela (ajax): espera o número do EPE aparecer
        text = ""
        for _ in range(40):
            text = await dialog.inner_text()
            if epe in text and re.search(r"processad", text, re.IGNORECASE):
                break
            await asyncio.sleep(0.25)
        await self.ctx.logger.info(f"Mensagem da EFD lida: EPE {epe}.", step="checking_processing")
        await self._close(dialog)
        return text

    async def _close(self, dialog: Locator) -> None:
        close = await first_visible([dialog.get_by_role("button", name=self.sel.rx("dte_close_button"))], 3_000)
        if close is None:
            close = await find_clickable(dialog, self.sel.rx("dte_close_button"), timeout_ms=1_000)
        if close is not None:
            await close.click()
        else:
            await self.page.keyboard.press("Escape")
        try:
            await dialog.wait_for(state="hidden", timeout=5_000)
        except Exception:  # noqa: BLE001
            await self.page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
