r"""Ícone do robô ao lado do relógio (bandeja do Windows).

    .venv\Scripts\pythonw.exe -m app.tray

- Cor: verde = ligado e aguardando; azul = trabalhando no SIAT;
  vermelho = algum agendamento precisa de atenção; cinza = robô parado.
- Menu: abrir painel, abrir pasta das notas, mostrar/esconder o navegador do
  robô (ele trabalha com a janela fora da tela), ligar/parar o robô, ver log.
- Avisos no canto da tela: notas baixadas neste computador e agendamentos
  que falharam ou aguardam você.

O ícone só mostra e controla; quem trabalha é o worker (tarefa agendada
"SIAT Automacao - Robo"). Fechar o ícone NÃO para o robô.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import pystray

from app import __version__
from app.config import PROJECT_ROOT, WORKER_ROOT, Settings, get_settings
from app.logs.job_logger import configure_logging
from app.tray_icons import draw

log = logging.getLogger("tray")

TASK_NAME = "SIAT Automacao - Robo"
PROBLEM_STATUSES = ["failed", "manual_action_required", "certificate_required"]
WAITING_USER = {"manual_action_required": "aguarda você", "certificate_required": "precisa do certificado"}
DOC_LABEL = {"NFCE": "NFC-e", "NFE_EMITIDAS": "NF-e emitidas", "NFE_RECEBIDAS": "NF-e recebidas"}
STALE_SECONDS = 30  # sem atualizar o status há mais que isso = robô parado
_NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


def _single_instance() -> object | None:
    """Mutex do Windows: só um ícone por usuário."""
    if sys.platform != "win32":
        return object()
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\SiatAutomacaoTray")
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return None
    return handle


@dataclass
class TrayState:
    robot: str = "stopped"  # stopped | idle | busy
    attention: list[str] = field(default_factory=list)
    dry_run: bool = False
    update_to: str | None = None  # versão nova disponível
    browser: str = "none"  # navegador do robô: none (fechado) | hidden | shown

    @property
    def color(self) -> str:
        if self.robot == "stopped":
            return "stopped"
        if self.attention:
            return "attention"
        return self.robot

    @property
    def text(self) -> str:
        base = {
            "stopped": "Robô parado",
            "idle": "Robô ligado, aguardando",
            "busy": "Robô trabalhando no SIAT",
        }[self.robot]
        if self.dry_run and self.robot != "stopped":
            base += " (modo de teste)"
        if self.attention:
            base += f" · {len(self.attention)} precisa(m) de atenção"
        return base


def read_local_status(path: Path, now: datetime | None = None) -> tuple[str, bool]:
    """Estado do robô pelo arquivo que o worker grava a cada 5 s."""
    now = now or datetime.now(timezone.utc)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        updated = datetime.fromisoformat(data["updated_at"])
    except (OSError, ValueError, KeyError):
        return "stopped", False
    status = data.get("status")
    if status not in ("idle", "busy") or (now - updated).total_seconds() > STALE_SECONDS:
        return "stopped", bool(data.get("dry_run"))
    return status, bool(data.get("dry_run"))


def read_browser_state(path: Path, now: datetime | None = None) -> str:
    """Janela do navegador do robô (none | hidden | shown), pelo mesmo arquivo de status."""
    now = now or datetime.now(timezone.utc)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        updated = datetime.fromisoformat(data["updated_at"])
    except (OSError, ValueError, KeyError):
        return "none"
    state = data.get("browser")
    if state not in ("hidden", "shown") or (now - updated).total_seconds() > STALE_SECONDS:
        return "none"
    return state


def read_update_status(settings: Settings) -> str | None:
    """Versão nova informada pelo robô (storage/update-status.json), se for mais nova que a instalada."""
    from app.updater import is_newer, read_status

    latest = read_status(settings).get("latest")
    return latest if latest and is_newer(latest) else None


class RemoteWatcher:
    """Consulta o Supabase: agendamentos com problema e notas recém-baixadas."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None
        self.last_download_at = datetime.now(timezone.utc)
        self.known_problems: set[str] | None = None

    def _db(self):
        if self._client is None:
            from app.services.supabase_client import create_sync_client

            self._client = create_sync_client(self.settings)
        return self._client

    def poll(self) -> tuple[list[str], list[str]]:
        """Retorna (lista de atenção, novos avisos)."""
        if not self.settings.supabase_configured:
            return [], []
        db = self._db()
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        jobs = (
            db.table("automation_jobs")
            .select("id, status, competence, updated_at, clients(client_code, legal_name, trade_name)")
            .in_("status", PROBLEM_STATUSES)
            .gte("updated_at", since)
            .order("updated_at", desc=True)
            .limit(20)
            .execute()
        ).data or []
        attention, notices = [], []
        ids = set()
        for j in jobs:
            c = j.get("clients") or {}
            name = c.get("trade_name") or c.get("legal_name") or c.get("client_code") or "Cliente"
            what = WAITING_USER.get(j["status"], "falhou")
            label = f"{name} {j['competence'][5:]}/{j['competence'][:4]}: {what}"
            attention.append(label)
            ids.add(j["id"])
            if self.known_problems is not None and j["id"] not in self.known_problems:
                notices.append(label)
        self.known_problems = ids

        rows = (
            db.table("downloads")
            .select("filepath, document_type, competence, downloaded_at, clients(client_code, legal_name, trade_name)")
            .gt("downloaded_at", self.last_download_at.isoformat())
            .order("downloaded_at")
            .limit(50)
            .execute()
        ).data or []
        grouped: dict[str, list[str]] = {}
        for r in rows:
            self.last_download_at = max(self.last_download_at, datetime.fromisoformat(r["downloaded_at"]))
            if not Path(r["filepath"]).is_file():
                continue  # baixada por outro computador
            c = r.get("clients") or {}
            name = c.get("trade_name") or c.get("legal_name") or c.get("client_code") or "Cliente"
            key = f"{name} {r['competence'][5:]}/{r['competence'][:4]}"
            grouped.setdefault(key, []).append(DOC_LABEL.get(r["document_type"], r["document_type"]))
        for key, docs in grouped.items():
            notices.append(f"Notas baixadas: {key} ({', '.join(docs)})")
        return attention, notices


class RobotTray:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.state = TrayState()
        self.remote = RemoteWatcher(settings)
        self._stop = threading.Event()
        self._last_color = ""
        self._last_title = ""
        self._last_menu: tuple | None = None
        self.icon = pystray.Icon(
            "siat-robo",
            draw("stopped"),
            "JR Sistema Robô",
            menu=pystray.Menu(
                pystray.MenuItem(lambda _i: self.state.text, None, enabled=False),
                pystray.MenuItem(f"Versão {__version__}", None, enabled=False),
                pystray.MenuItem(
                    lambda _i: f"Precisam de atenção ({len(self.state.attention)})",
                    pystray.Menu(
                        lambda: [pystray.MenuItem(t, self.open_panel) for t in self.state.attention[:10]]
                    ),
                    visible=lambda _i: bool(self.state.attention),
                ),
                pystray.Menu.SEPARATOR,
                # todo dia
                pystray.MenuItem("Abrir painel", self.open_panel, default=True),
                pystray.MenuItem("Abrir pasta das notas", self.open_downloads),
                pystray.MenuItem(
                    lambda _i: "Esconder navegador do robô" if self.state.browser == "shown" else "Mostrar navegador do robô",
                    self.toggle_browser,
                    enabled=lambda _i: self.state.browser != "none",
                ),
                pystray.Menu.SEPARATOR,
                # controle do robô
                pystray.MenuItem("Ligar robô", self.start_robot, enabled=lambda _i: self.state.robot == "stopped"),
                pystray.MenuItem("Parar robô", self.stop_robot, enabled=lambda _i: self.state.robot != "stopped"),
                pystray.MenuItem(
                    lambda _i: f"Atualizar agora (versão {self.state.update_to})",
                    self.update_now,
                    visible=lambda _i: bool(self.state.update_to),
                ),
                pystray.Menu.SEPARATOR,
                # configuração (uma vez) e ajuda
                pystray.MenuItem("Status e verificação", self.check_setup),
                pystray.MenuItem("Salvar notas no Google Drive", self.setup_google_drive),
                pystray.MenuItem(
                    "⚠ Ativar este computador…",
                    self.activate,
                    visible=lambda _i: self.settings.auth_mode != "device",
                ),
                pystray.MenuItem(
                    "Ajuda e suporte",
                    pystray.Menu(
                        pystray.MenuItem("Manual do JR Sistema", self.open_manual),
                        pystray.MenuItem("Falar com o suporte (WhatsApp)", self.open_support),
                        pystray.MenuItem("Mensagens do robô (log)", self.open_log),
                    ),
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Sair", self.stop_and_quit),
            ),
        )

    # -- ações do menu ----------------------------------------------------------
    def open_panel(self, *_a) -> None:
        os.startfile(self.settings.panel_url)  # noqa: S606

    def open_downloads(self, *_a) -> None:
        # lê o .env de novo: a pasta pode ter mudado ("Salvar notas no Google Drive") com o ícone aberto
        current = Settings()
        folder = current.downloads_dir
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError:
            self.icon.notify(
                "A pasta das notas não está disponível agora (o Google Drive está aberto?). Abri a pasta local do robô.",
                "JR Sistema Robô",
            )
            folder = current.local_downloads_dir
            folder.mkdir(parents=True, exist_ok=True)
        os.startfile(folder)  # noqa: S606

    def toggle_browser(self, *_a) -> None:
        """O robô trabalha com o Chrome fora da tela; aqui ele aparece (na frente) ou volta a se esconder."""
        wanted = "esconder" if self.state.browser == "shown" else "mostrar"
        if wanted == "mostrar" and sys.platform == "win32":
            # quem clicou no menu pode trazer janelas para a frente: libera para o Chrome do robô
            ctypes.windll.user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
        flag = self.settings.browser_flag
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text(wanted, encoding="utf-8")
        # o worker atende em até 1 s; o texto do menu já muda agora
        self.state.browser = "shown" if wanted == "mostrar" else "hidden"

    def setup_google_drive(self, *_a) -> None:
        """Janela que liga o robô a uma pasta do Google Drive (pede administrador, igual ao robô)."""
        self._open_tool("app.tools.google_drive", admin=True)

    def open_log(self, *_a) -> None:
        path = self.settings.log_file
        if path and path.is_file():
            os.startfile(path)  # noqa: S606
        else:
            self.icon.notify("Ainda não há mensagens do robô.", "JR Sistema Robô")

    def open_manual(self, *_a) -> None:
        """O manual instalado junto com o robô (docs/manual); sem ele, o da última versão publicada."""
        local = PROJECT_ROOT / "docs" / "manual" / "Manual-SIAT-Robo.pdf"
        os.startfile(local if local.is_file() else self.settings.manual_url)  # noqa: S606

    def open_support(self, *_a) -> None:
        """Conversa no WhatsApp com o suporte do JR Sistema (número em SUPPORT_WHATSAPP)."""
        digits = re.sub(r"\D", "", self.settings.support_whatsapp)
        if not digits:
            self.icon.notify("Nenhum contato de suporte configurado.", "JR Sistema Robô")
            return
        text = quote(f"Olá! Preciso de ajuda com o JR Sistema Robô (computador {socket.gethostname()}).")
        os.startfile(f"https://wa.me/{digits}?text={text}")  # noqa: S606

    def start_robot(self, *_a) -> None:
        self.settings.stop_flag.unlink(missing_ok=True)
        proc = subprocess.run(  # noqa: S603
            ["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, text=True, creationflags=_NO_WINDOW
        )
        if proc.returncode != 0:
            # sem permissão para disparar a tarefa: pede administrador pelo iniciar-robo.bat
            bat = PROJECT_ROOT / "iniciar-robo.bat"
            ctypes.windll.shell32.ShellExecuteW(None, "runas", str(bat), None, str(PROJECT_ROOT), 0)
        self.icon.notify("Ligando o robô…", "JR Sistema Robô")

    def stop_robot(self, *_a) -> None:
        flag = self.settings.stop_flag
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("parar", encoding="utf-8")
        self.icon.notify("O robô vai terminar o trabalho atual e parar.", "JR Sistema Robô")

    def _open_tool(self, module: str, *, admin: bool = False) -> None:
        """Abre uma ferramenta na janela do JR Sistema (pythonw: sem tela preta)."""
        exe = Path(sys.executable).with_name("pythonw.exe")
        exe = exe if exe.is_file() else Path(sys.executable)
        rc = ctypes.windll.shell32.ShellExecuteW(
            None, "runas" if admin else "open", str(exe), f"-m {module} --gui", str(WORKER_ROOT), 1
        )
        if rc <= 32:
            self.icon.notify(
                "É preciso clicar em Sim no pedido de permissão para continuar."
                if admin
                else "Não foi possível abrir a ferramenta. Reinstale o robô.",
                "JR Sistema Robô",
            )

    def activate(self, *_a) -> None:
        """Janela de ativação (pede o código gerado em Computadores, no painel)."""
        self._open_tool("app.tools.activate")

    def check_setup(self, *_a) -> None:
        """Janela "Status e verificação": acesso, Chrome, pasta das notas, certificados e início automático."""
        self._open_tool("app.tools.check_setup")

    def update_now(self, *_a) -> None:
        """O robô termina o trabalho atual; o serviço instala a versão nova e religa."""
        flag = self.settings.update_flag
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text(self.state.update_to or "", encoding="utf-8")
        if self.state.robot == "stopped":
            self.start_robot()  # ao ligar, o serviço já atualiza antes de trabalhar
        self.icon.notify(
            "O robô vai terminar o trabalho atual, instalar a versão nova e voltar sozinho em 1 a 2 minutos.",
            "JR Sistema Robô",
        )

    def stop_and_quit(self, *_a) -> None:
        """Desliga tudo: o robô termina o trabalho atual e para; o ícone fecha na hora."""
        if self.state.robot != "stopped":
            self.stop_robot()
        self.quit()

    def quit(self, *_a) -> None:
        self._stop.set()
        self.icon.stop()

    # -- atualização --------------------------------------------------------------
    def _reload_if_activated(self) -> None:
        """Depois da ativação o .env muda: passa a usar o acesso do computador."""
        fresh = Settings()
        if fresh.device_email != self.settings.device_email:
            self.settings = fresh
            self.remote = RemoteWatcher(fresh)
            self.icon.notify("Computador ativado. O robô já usa o acesso deste escritório.", "JR Sistema Robô")

    def _refresh(self) -> None:
        self._reload_if_activated()
        robot, dry_run = read_local_status(self.settings.status_file)
        self.state.robot, self.state.dry_run = robot, dry_run
        self.state.browser = read_browser_state(self.settings.status_file) if robot != "stopped" else "none"
        update = read_update_status(self.settings)
        if update and update != self.state.update_to:
            self.icon.notify(
                f"Versão {update} do JR Sistema Robô disponível. Ela será instalada sozinha quando o robô estiver "
                "parado, ou clique em Atualizar agora no menu do ícone.",
                "JR Sistema Robô",
            )
        self.state.update_to = update
        color = self.state.color
        if color != self._last_color:
            self.icon.icon = draw(color)
            self._last_color = color
        title = f"JR Sistema Robô · {self.state.text}"[:127]
        if title != self._last_title:
            self.icon.title = title
            self._last_title = title
        # o menu só é refeito quando algo dele muda: refazê-lo a cada 5 s, com ele aberto, trava a tela
        menu = (self.state.text, tuple(self.state.attention), self.state.update_to, self.settings.auth_mode, self.state.browser)
        if menu != self._last_menu:
            self.icon.update_menu()
            self._last_menu = menu

    def _loop(self, icon: pystray.Icon) -> None:
        icon.visible = True
        next_remote = 0.0
        while not self._stop.is_set():
            try:
                if time.monotonic() >= next_remote:
                    next_remote = time.monotonic() + 60
                    attention, notices = self.remote.poll()
                    self.state.attention = attention
                    for msg in notices[:3]:
                        icon.notify(msg, "JR Sistema Robô")
                        time.sleep(4)
            except Exception as exc:  # noqa: BLE001 - sem internet etc.: tenta de novo depois
                log.warning("Consulta ao Supabase falhou: %s", exc)
            try:
                self._refresh()
            except Exception:  # noqa: BLE001
                log.exception("Falha ao atualizar o ícone")
            self._stop.wait(5)

    def run(self) -> None:
        self.icon.run(setup=self._loop)


def main() -> None:
    settings = get_settings()
    log_file = settings.log_file.with_name("tray.log") if settings.log_file else None
    configure_logging(settings.log_level, log_file)
    if _single_instance() is None:
        return  # já existe um ícone aberto
    RobotTray(settings).run()


if __name__ == "__main__":
    main()
