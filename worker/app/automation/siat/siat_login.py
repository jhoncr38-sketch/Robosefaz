"""Login no SIAT Web com certificado digital.

Fluxo:
1. Abre /painel-aplicacoes/login (sessão do perfil pode já estar ativa).
2. Clica na opção "Certificado Digital".
3. Web PKI (Lacuna) pode pedir autorização "Permitir": é uma decisão do
   usuário -> aguardamos intervenção manual (uma vez por perfil).
4. Se o portal listar os certificados na página ("Selecione um Certificado"),
   escolhemos a linha que corresponde EXATAMENTE ao certificado do cliente.
   Ambiguidade ou ausência -> intervenção manual.
5. Se nada aparecer na página, provavelmente o Chrome abriu a janela nativa
   de certificados: status waiting_certificate até o usuário escolher.
CAPTCHA e 2FA nunca são contornados: viram manual_action_required.
"""

from __future__ import annotations

import asyncio

from playwright.async_api import Error as PlaywrightError, Page

from app.automation.base import AutomationContext
from app.automation.siat.page_helpers import dialog_by_title, find_clickable, table_rows, text_visible, wait_idle
from app.automation.siat.selectors import SiatSelectors, get_selectors
from app.certificates.certificate_selector import CertificateSelector
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.state_machine import JobStatus

WAITING_CERTIFICATE_MESSAGE = "Aguardando seleção do certificado digital."


class SiatLogin:
    def __init__(self, ctx: AutomationContext, selectors: SiatSelectors | None = None) -> None:
        self.ctx = ctx
        self.sel = selectors or get_selectors()

    @property
    def page(self) -> Page:
        if self.ctx.page is None:
            raise AutomationError(ErrorCode.BROWSER_ERROR, "Navegador não iniciado.")
        return self.ctx.page

    @property
    def login_url(self) -> str:
        return self.ctx.settings.siat_base_url.rstrip("/") + self.sel.login_path

    async def is_logged_in(self) -> bool:
        try:
            url = self.page.url
            if self.sel.rx("auth_url_marker").search(url) or self.sel.rx("login_url_marker").search(url):
                return False
            if self.sel.rx("logged_in_url_marker").search(url):
                return True
            return await text_visible(self.page, self.sel.rx("logged_in_markers"))
        except PlaywrightError:
            return False

    async def _check_blockers(self) -> None:
        """CAPTCHA/2FA: nunca automatizar; pedir ação ao usuário."""
        if await text_visible(self.page, self.sel.rx("captcha_markers")):
            await self.ctx.reporter.wait_for_user_confirmation(
                "O SIAT exibiu uma verificação CAPTCHA. Resolva-a no navegador do robô e clique em Continuar.",
                resolved=self.is_logged_in,
            )
        if await text_visible(self.page, self.sel.rx("two_factor_markers")):
            await self.ctx.reporter.wait_for_user_confirmation(
                "O SIAT solicitou verificação adicional (2FA). Conclua no navegador do robô e clique em Continuar.",
                resolved=self.is_logged_in,
            )

    async def open(self) -> None:
        await self.ctx.reporter.step(JobStatus.OPENING_SIAT, "Abrindo SIAT")
        try:
            await self.page.goto(self.login_url, wait_until="domcontentloaded")
        except PlaywrightError as exc:
            raise AutomationError(ErrorCode.SIAT_UNAVAILABLE, f"Não foi possível abrir o SIAT: {exc}") from exc
        await wait_idle(self.page)
        await self.ctx.reporter.screenshot("siat_login_page")

    async def _handle_certificate_dialog(self) -> bool:
        """Retorna True se tratou o diálogo de certificados da página."""
        dialog = await dialog_by_title(self.page, self.sel.rx("certificate_dialog_title"), timeout_ms=500)
        if dialog is None:
            return False
        await wait_idle(self.page, 10_000)
        rows = await table_rows(dialog)
        texts = [(await r.inner_text()).strip() for r in rows]
        texts = [t for t in texts if t]
        if self.ctx.certificate is None:
            raise AutomationError(ErrorCode.CERTIFICATE_REQUIRED, "Certificado não configurado.")
        choice = CertificateSelector(self.ctx.certificate, self.ctx.client.cnpj).choose(texts)
        await self.ctx.logger.info(
            f"Certificados listados pelo portal: {len(texts)}. {choice.reason}", step="waiting_certificate"
        )
        if not choice.found:
            await self.ctx.reporter.wait_for_user_confirmation(
                f"{WAITING_CERTIFICATE_MESSAGE} {choice.reason} Selecione o certificado de "
                f"{self.ctx.client.display_name} no navegador do robô.",
                status=JobStatus.WAITING_CERTIFICATE,
                resolved=self.is_logged_in,
                timeout_ms=self.ctx.settings.certificate_selection_timeout,
            )
            return True
        await rows[choice.index].click()  # type: ignore[index]
        await wait_idle(self.page)
        return True

    async def _wait_login_or_prompts(self, timeout_ms: int) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_ms / 1000
        while loop.time() < deadline:
            await self.ctx.reporter.check_cancel()
            if await self.is_logged_in():
                return True
            if await text_visible(self.page, self.sel.rx("webpki_authorization_prompt")):
                await self.ctx.reporter.wait_for_user_confirmation(
                    "O componente Web PKI pede autorização para acessar os certificados. "
                    "Clique em 'Permitir' no navegador do robô (necessário uma única vez por perfil).",
                    status=JobStatus.WAITING_CERTIFICATE,
                    resolved=self._prompt_gone,
                    timeout_ms=self.ctx.settings.certificate_selection_timeout,
                )
                deadline = loop.time() + timeout_ms / 1000
                continue
            if await self._handle_certificate_dialog():
                deadline = loop.time() + timeout_ms / 1000
                continue
            if await text_visible(self.page, self.sel.rx("certificate_expired_message")):
                raise AutomationError(ErrorCode.CERTIFICATE_EXPIRED, "O SIAT informou que o certificado está expirado.")
            await self._check_blockers()
            await asyncio.sleep(0.5)
        return await self.is_logged_in()

    async def _prompt_gone(self) -> bool:
        return not await text_visible(self.page, self.sel.rx("webpki_authorization_prompt"))

    # -- diagnóstico e recuperação ------------------------------------------------
    def _on_callback(self) -> bool:
        try:
            return bool(self.sel.rx("callback_url_marker").search(self.page.url))
        except PlaywrightError:
            return False

    def _start_diagnostics(self) -> None:
        """Guarda erros da página e requisições do SIAT que falharam (para suporte)."""
        self._diag: list[str] = []
        domain = self.sel.rx("siat_cookie_domain")

        def add(entry: str) -> None:
            self._diag.append(entry[:300])
            del self._diag[:-12]

        def on_console(msg) -> None:  # noqa: ANN001
            if msg.type == "error":
                add(f"console: {msg.text}")

        def on_request_failed(req) -> None:  # noqa: ANN001
            add(f"falhou {req.method} {req.url.split('?')[0]} ({req.failure})")

        def on_response(resp) -> None:  # noqa: ANN001
            host = resp.url.split("/")[2] if "://" in resp.url else ""
            if resp.status >= 400 and domain.search(host):
                add(f"HTTP {resp.status} {resp.request.method} {resp.url.split('?')[0]}")

        self._listeners = {"console": on_console, "requestfailed": on_request_failed, "response": on_response}
        for event, handler in self._listeners.items():
            self.page.on(event, handler)

    def _stop_diagnostics(self) -> None:
        for event, handler in getattr(self, "_listeners", {}).items():
            try:
                self.page.remove_listener(event, handler)
            except Exception:  # noqa: BLE001
                pass
        self._listeners = {}

    def _diagnostics_text(self) -> str:
        entries = getattr(self, "_diag", [])
        return " | ".join(entries[-6:]) if entries else "nenhum erro registrado pela página"

    async def _reset_siat_session(self) -> None:
        """Remove cookies e armazenamento SOMENTE dos domínios do SIAT neste perfil."""
        await self.page.context.clear_cookies(domain=self.sel.rx("siat_cookie_domain"))
        await self.page.goto(self.login_url, wait_until="domcontentloaded")
        await self.page.evaluate("() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }")
        await self.page.goto(self.login_url, wait_until="domcontentloaded")
        await wait_idle(self.page)

    async def login(self) -> None:
        self._start_diagnostics()
        try:
            await self._login()
        finally:
            self._stop_diagnostics()

    async def _login(self) -> None:
        await self.open()
        if await self.is_logged_in():
            await self.ctx.logger.info("Sessão do SIAT reaproveitada do perfil do cliente.", step="authenticating")
            await self.ctx.reporter.step(JobStatus.AUTHENTICATING, "Sessão existente")
            return

        await self._check_blockers()
        cert = self.ctx.certificate
        if cert is not None and cert.requires_manual_selection:
            await self._click_certificate_option()
            await self.ctx.reporter.wait_for_user_confirmation(
                WAITING_CERTIFICATE_MESSAGE,
                status=JobStatus.WAITING_CERTIFICATE,
                resolved=self.is_logged_in,
                timeout_ms=self.ctx.settings.certificate_selection_timeout,
            )
        else:
            await self._click_certificate_option()
            logged = await self._wait_login_or_prompts(self.ctx.settings.login_detection_timeout)
            if not logged and self._on_callback():
                # Certificado aceito, mas o retorno travou (dados antigos do SIAT no
                # perfil). Limpa só os dados do SIAT e refaz o login uma vez.
                await self.ctx.logger.warning(
                    "O SIAT aceitou o certificado, mas o retorno do login (/callback) travou. "
                    "Limpando os dados do SIAT neste perfil e tentando novamente. "
                    f"Diagnóstico: {self._diagnostics_text()}",
                    step="authenticating",
                )
                await self._reset_siat_session()
                await self._click_certificate_option()
                logged = await self._wait_login_or_prompts(self.ctx.settings.login_detection_timeout)
                if not logged and self._on_callback():
                    raise AutomationError(
                        ErrorCode.LOGIN_FAILED,
                        "O certificado foi aceito, mas o SIAT não concluiu o retorno do login (/callback). "
                        f"Diagnóstico: {self._diagnostics_text()}",
                    )
            if not logged:
                # Nada na página: janela nativa do navegador aguardando o usuário.
                await self.ctx.reporter.wait_for_user_confirmation(
                    WAITING_CERTIFICATE_MESSAGE,
                    status=JobStatus.WAITING_CERTIFICATE,
                    resolved=self.is_logged_in,
                    timeout_ms=self.ctx.settings.certificate_selection_timeout,
                )

        await self.ctx.reporter.step(JobStatus.AUTHENTICATING, "Confirmando autenticação")
        await wait_idle(self.page)
        if not await self._wait_login_or_prompts(10_000):
            raise AutomationError(ErrorCode.LOGIN_FAILED, "Não foi possível confirmar o login no SIAT.")
        await self.ctx.logger.info("Login no SIAT confirmado.", step="authenticating")
        await self.ctx.reporter.screenshot("siat_logged_in")

    async def _click_certificate_option(self) -> None:
        option = await find_clickable(self.page, self.sel.rx("login_certificate_option"), timeout_ms=15_000)
        if option is None:
            raise AutomationError(
                ErrorCode.SELECTOR_NOT_FOUND,
                "Opção 'Certificado Digital' não encontrada na tela de login do SIAT.",
            )
        # Não aguardar navegação: o clique pode abrir a janela nativa de certificados.
        try:
            await option.click(timeout=10_000)
        except PlaywrightError as exc:
            if "Timeout" not in str(exc):
                raise

    async def logout(self) -> None:
        """Encerra a sessão no portal (best effort)."""
        try:
            btn = await find_clickable(self.page, self.sel.rx("logout_button"), timeout_ms=2_000)
            if btn is not None:
                await btn.click(timeout=5_000)
                await wait_idle(self.page, 5_000)
        except PlaywrightError:
            pass
