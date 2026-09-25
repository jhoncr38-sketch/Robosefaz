"""Abertura assistida do perfil de navegador de um cliente para configuração manual.

Usado uma vez por cliente para: instalar/habilitar a extensão Lacuna Web PKI,
autorizar o acesso aos certificados ("Permitir") e testar o login no SIAT.
Nada é automatizado aqui: o navegador apenas fica aberto para o usuário.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.browser.browser_factory import BrowserOptions, BrowserSession
from app.browser.event_loop import run_playwright
from app.certificates.certificate_profile import CertificateProfile
from app.config import Settings
from app.jobs.errors import AutomationError
from app.jobs.models import Certificate, Client

log = logging.getLogger(__name__)


@dataclass(slots=True)
class SetupSession:
    client_id: str
    started_at: datetime
    status: str = "starting"  # starting | open | closed | error
    message: str = ""
    task: asyncio.Task | None = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "client_id": self.client_id,
            "started_at": self.started_at.isoformat(),
            "status": self.status,
            "message": self.message,
        }


class ProfileSetupService:
    def __init__(self) -> None:
        self._sessions: dict[str, SetupSession] = {}

    def get(self, client_id: str) -> SetupSession | None:
        return self._sessions.get(client_id)

    def start(self, settings: Settings, client: Client, certificate: Certificate | None) -> SetupSession:
        current = self._sessions.get(client.id)
        if current and current.status in ("starting", "open"):
            return current
        session = SetupSession(client_id=client.id, started_at=datetime.now(timezone.utc))
        session.task = asyncio.create_task(
            run_playwright(lambda: self._run(session, settings, client, certificate))
        )
        self._sessions[client.id] = session
        return session

    async def _run(self, session: SetupSession, settings: Settings, client: Client, certificate: Certificate | None) -> None:
        try:
            profile = CertificateProfile(settings.profiles_dir, client, certificate)
            user_data_dir, _ = profile.prepare()
            options = BrowserOptions.from_settings(settings, user_data_dir, profile.downloads_tmp_dir, owner="profile-setup")
            options.headless = False
            async with BrowserSession(options) as browser:
                assert browser.page is not None and browser.context is not None
                await browser.page.goto(settings.siat_login_url, wait_until="domcontentloaded")
                session.status = "open"
                session.message = "Perfil aberto na máquina do worker. Feche o navegador ao terminar."
                closed = asyncio.Event()
                browser.context.on("close", lambda *_: closed.set())
                try:
                    await asyncio.wait_for(closed.wait(), timeout=settings.profile_setup_timeout)
                    session.message = "Navegador fechado pelo usuário."
                except asyncio.TimeoutError:
                    session.message = "Tempo de configuração esgotado; navegador fechado."
            session.status = "closed"
        except AutomationError as exc:
            session.status = "error"
            session.message = exc.message
        except Exception as exc:  # noqa: BLE001
            log.exception("Falha ao abrir perfil para configuração")
            session.status = "error"
            session.message = str(exc)


profile_setup_service = ProfileSetupService()
