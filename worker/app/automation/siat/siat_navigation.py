"""Navegação: Painel de aplicações -> e-AGEAT -> "Autorregularização" -> "SIAT" (SIAT web).

O e-AGEAT às vezes abre com "Error 500" ou "Usuário não identificado". O
contorno (o mesmo do usuário) é fechar a aba, voltar ao Painel de aplicações
e clicar no card de novo. O botão "Efetuar login" NÃO é usado: ele leva à
página pública do SIAT, sem sessão.
"""

from __future__ import annotations

import asyncio

from playwright.async_api import Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import find_clickable, text_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.automation.siat.siat_legacy import SiatLegacy
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.state_machine import JobStatus


class SiatNavigation:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()

    @property
    def page(self) -> Page:
        assert self.ctx.page is not None
        return self.ctx.page

    async def _adopt_new_tab(self, pages_before: int) -> None:
        """Aplicações do painel podem abrir em nova aba: passa a usá-la."""
        context = self.page.context
        for _ in range(20):
            if len(context.pages) > pages_before:
                new_page = context.pages[-1]
                await new_page.wait_for_load_state("domcontentloaded")
                await new_page.bring_to_front()
                self.ctx.page = new_page
                await self.ctx.logger.debug("Módulo aberto em nova aba.", step="opening_siat_module")
                return
            await asyncio.sleep(0.25)

    async def _is_server_error(self) -> bool:
        # página de erro do próprio Chrome (sem conexão, DNS, conexão recusada...)
        if self.page.url.startswith("chrome-error://"):
            return True
        return await text_visible(self.page, self.sel.rx("server_error_markers"))

    async def _module_problem(self) -> str | None:
        """Motivo para fechar e clicar de novo no e-AGEAT (ou None se abriu bem)."""
        if await self._is_server_error():
            return "erro do servidor"
        if await text_visible(self.page, self.sel.rx("module_login_required")):
            return "'Usuário não identificado'"
        if await text_visible(self.page, self.sel.rx("logged_out_markers")):
            return "página pública sem sessão"
        return None

    async def open_module(self) -> None:
        await self.ctx.reporter.step(JobStatus.OPENING_SIAT_MODULE, "Abrindo e-AGEAT")
        painel = self.page
        painel_url = painel.url
        attempts = max(1, self.ctx.settings.module_open_attempts)
        for attempt in range(1, attempts + 1):
            link = await find_clickable(painel, self.sel.rx("module_link"), timeout_ms=10_000)
            if link is None:
                raise AutomationError(ErrorCode.SELECTOR_NOT_FOUND, "Card do e-AGEAT não encontrado no Painel de Aplicações.")
            pages_before = len(painel.context.pages)
            await link.click()
            await self._adopt_new_tab(pages_before)
            await wait_idle(self.page)
            await self.ctx.reporter.screenshot(f"siat_module_{attempt}")
            problem = await self._module_problem()
            await self.ctx.logger.info(
                f"e-AGEAT (tentativa {attempt}) abriu: {self.page.url.split('?')[0]}"
                + (f" — {problem}" if problem else ""),
                step="opening_siat_module",
            )
            if problem is None:
                return
            await self.ctx.logger.warning(
                f"e-AGEAT abriu com {problem} (tentativa {attempt}/{attempts}); "
                "fechando e clicando de novo no Painel de Aplicações.",
                step="opening_siat_module",
            )
            # mesmo contorno do usuário: fecha a aba problemática e clica de novo
            if self.page is not painel:
                await self.page.close()
                self.ctx.page = painel
                await painel.bring_to_front()
            else:
                await painel.goto(painel_url, wait_until="domcontentloaded")
            await wait_idle(painel)
            await asyncio.sleep(self.ctx.settings.module_retry_delay)
        raise AutomationError(
            ErrorCode.SIAT_UNAVAILABLE,
            f"O e-AGEAT não abriu corretamente em {attempts} tentativas seguidas.",
        )

    async def ensure_export_area(self) -> None:
        """Garante o SIAT web legado aberto (uma vez por sessão)."""
        legacy = SiatLegacy(self.ctx, self.sel)
        if self.ctx.state.get("legacy_ready") and legacy.on_legacy():
            return
        await self.open_module()
        await self.ctx.reporter.step(JobStatus.NAVIGATING_EXPORT, "Abrindo SIAT web (Autorregularização > SIAT)")
        await legacy.open_from_eageat()
        self.ctx.state["legacy_ready"] = True
        self.ctx.state.pop("legacy_page", None)
