r"""Ícone do robô ao lado do relógio (bandeja do Windows).

    .venv\Scripts\pythonw.exe -m app.tray

- Cor: verde = ligado e aguardando; azul = trabalhando no SIAT;
  vermelho = algum agendamento precisa de atenção; cinza = robô parado.
- Menu: abrir painel, abrir pasta das notas, ligar/parar o robô, ver log.
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
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pystray

from app.config import PROJECT_ROOT, Settings, get_settings
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


class RemoteWatcher:
    """Consulta o Supabase: agendamentos com problema e notas recém-baixadas."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client = None
        self.last_download_at = datetime.now(timezone.utc)
        self.known_problems: set[str] | None = None

    def _db(self):
        if self._client is None:
            from supabase import create_client

            self._client = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)
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
        self.icon = pystray.Icon(
            "siat-robo",
            draw("stopped"),
            "SIAT Robô",
            menu=pystray.Menu(
                pystray.MenuItem(lambda _i: self.state.text, None, enabled=False),
                pystray.MenuItem(
                    lambda _i: f"Precisam de atenção ({len(self.state.attention)})",
                    pystray.Menu(
                        lambda: [pystray.MenuItem(t, self.open_panel) for t in self.state.attention[:10]]
                    ),
                    visible=lambda _i: bool(self.state.attention),
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Abrir painel", self.open_panel, default=True),
                pystray.MenuItem("Abrir pasta das notas", self.open_downloads),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Ligar robô", self.start_robot, enabled=lambda _i: self.state.robot == "stopped"),
                pystray.MenuItem("Parar robô", self.stop_robot, enabled=lambda _i: self.state.robot != "stopped"),
                pystray.MenuItem("Ver mensagens do robô (log)", self.open_log),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Fechar este ícone (o robô continua)", self.quit),
            ),
        )

    # -- ações do menu ----------------------------------------------------------
    def open_panel(self, *_a) -> None:
        os.startfile(self.settings.panel_url)  # noqa: S606

    def open_downloads(self, *_a) -> None:
        folder = self.settings.downloads_dir
        folder.mkdir(parents=True, exist_ok=True)
        os.startfile(folder)  # noqa: S606

    def open_log(self, *_a) -> None:
        path = self.settings.log_file
        if path and path.is_file():
            os.startfile(path)  # noqa: S606
        else:
            self.icon.notify("Ainda não há mensagens do robô.", "SIAT Robô")

    def start_robot(self, *_a) -> None:
        self.settings.stop_flag.unlink(missing_ok=True)
        proc = subprocess.run(  # noqa: S603
            ["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, text=True, creationflags=_NO_WINDOW
        )
        if proc.returncode != 0:
            # sem permissão para disparar a tarefa: pede administrador pelo iniciar-robo.bat
            bat = PROJECT_ROOT / "iniciar-robo.bat"
            ctypes.windll.shell32.ShellExecuteW(None, "runas", str(bat), None, str(PROJECT_ROOT), 0)
        self.icon.notify("Ligando o robô…", "SIAT Robô")

    def stop_robot(self, *_a) -> None:
        flag = self.settings.stop_flag
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("parar", encoding="utf-8")
        self.icon.notify("O robô vai terminar o trabalho atual e parar.", "SIAT Robô")

    def quit(self, *_a) -> None:
        self._stop.set()
        self.icon.stop()

    # -- atualização --------------------------------------------------------------
    def _refresh(self) -> None:
        robot, dry_run = read_local_status(self.settings.status_file)
        self.state.robot, self.state.dry_run = robot, dry_run
        color = self.state.color
        if color != self._last_color:
            self.icon.icon = draw(color)
            self._last_color = color
        self.icon.title = f"SIAT Robô · {self.state.text}"[:127]
        self.icon.update_menu()

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
                        icon.notify(msg, "SIAT Robô")
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
