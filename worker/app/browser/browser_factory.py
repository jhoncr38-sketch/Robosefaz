"""Criação de sessões Playwright com perfil persistente exclusivo por cliente."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType

from playwright.async_api import BrowserContext, Error as PlaywrightError, Page, Playwright, async_playwright

from app.browser.event_loop import run_playwright
from app.browser.profile_lock import ProfileLock
from app.config import Settings
from app.jobs.errors import AutomationError, ErrorCode

log = logging.getLogger(__name__)


@dataclass(slots=True)
class BrowserOptions:
    user_data_dir: Path
    downloads_dir: Path
    headless: bool
    channel: str
    page_load_timeout: int
    action_timeout: int
    owner: str

    @classmethod
    def from_settings(cls, settings: Settings, user_data_dir: Path, downloads_dir: Path, owner: str) -> "BrowserOptions":
        return cls(
            user_data_dir=user_data_dir,
            downloads_dir=downloads_dir,
            headless=settings.automation_headless,
            channel=settings.browser_channel,
            page_load_timeout=settings.page_load_timeout,
            action_timeout=settings.action_timeout,
            owner=owner,
        )


class BrowserSession:
    """Contexto assíncrono: `async with BrowserSession(opts) as session: session.page`."""

    def __init__(self, options: BrowserOptions) -> None:
        self.options = options
        self._pw: Playwright | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self._lock = ProfileLock(options.user_data_dir.parent, options.owner)

    async def __aenter__(self) -> "BrowserSession":
        self._lock.acquire()
        try:
            self._pw = await async_playwright().start()
            launch_kwargs: dict = {
                "user_data_dir": str(self.options.user_data_dir),
                "headless": self.options.headless,
                "accept_downloads": True,
                "downloads_path": str(self.options.downloads_dir),
                "locale": "pt-BR",
                "timezone_id": "America/Fortaleza",
                "viewport": {"width": 1366, "height": 850},
                # mantém o sandbox do Chrome (o Playwright desliga por padrão);
                # importante porque o worker pode rodar como administrador
                "chromium_sandbox": True,
                # extensões (ex.: Lacuna Web PKI usada pelo SIAT) precisam ficar ativas
                "ignore_default_args": ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
            }
            if self.options.channel != "chromium":
                launch_kwargs["channel"] = self.options.channel
            try:
                self.context = await self._pw.chromium.launch_persistent_context(**launch_kwargs)
            except PlaywrightError as exc:
                if self.options.channel != "chromium" and "Executable doesn't exist" in str(exc):
                    log.warning("Canal %s não encontrado; usando Chromium do Playwright", self.options.channel)
                    launch_kwargs.pop("channel", None)
                    self.context = await self._pw.chromium.launch_persistent_context(**launch_kwargs)
                else:
                    raise
            self.context.set_default_navigation_timeout(self.options.page_load_timeout)
            self.context.set_default_timeout(self.options.action_timeout)
            self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
            return self
        except AutomationError:
            await self._cleanup()
            raise
        except Exception as exc:
            await self._cleanup()
            raise AutomationError(ErrorCode.BROWSER_ERROR, f"Falha ao abrir navegador: {exc}") from exc

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self._cleanup()

    async def _cleanup(self) -> None:
        try:
            if self.context is not None:
                await self.context.close()
        except Exception as e:  # pragma: no cover - fechamento best-effort
            log.debug("Erro ao fechar contexto: %s", e)
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception as e:  # pragma: no cover
            log.debug("Erro ao parar Playwright: %s", e)
        self.context = None
        self.page = None
        self._pw = None
        self._lock.release()


async def check_browser_available(settings: Settings) -> bool:
    """Verifica se o Playwright consegue iniciar o navegador configurado (headless, sem perfil)."""
    return await run_playwright(lambda: _check_browser(settings))


async def _check_browser(settings: Settings) -> bool:
    try:
        async with async_playwright() as pw:
            kwargs: dict = {"headless": True}
            if settings.browser_channel != "chromium":
                kwargs["channel"] = settings.browser_channel
            try:
                browser = await pw.chromium.launch(**kwargs)
            except PlaywrightError:
                browser = await pw.chromium.launch(headless=True)
            await browser.close()
        return True
    except Exception as exc:
        log.warning("Navegador indisponível: %s", exc)
        return False
