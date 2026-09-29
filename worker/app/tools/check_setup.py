r"""Confere se este computador está pronto para rodar o robô.

    ícone do robô / menu Iniciar → Status e verificação   (janela: --gui)
    .venv\Scripts\python.exe -m app.tools.check_setup [--gui]

Verifica (somente leitura, nada é alterado no Supabase nem no SIAT):
1. o robô: ligado ou parado, versão instalada e versão nova disponível;
2. este computador: Google Chrome, pasta das notas gravável, início automático,
   ativação e conexão com o painel;
3. certificados A1 dos clientes ativos instalados no Windows deste usuário
   (os com problema aparecem primeiro).

Código de saída 1 se algum item obrigatório falhar.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.certificates.windows_store import find_in_store, list_user_certificates
from app.config import Settings, get_settings
from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer
from app.tools.ui import ConsoleUI, ToolUI

TASK_NAME = "SIAT Automacao - Robo"
TITLE = "Status e verificação"
SUBTITLE = "Confere se este computador está pronto: acesso ao painel, Chrome, pasta das notas, certificados e início automático."

_CHROME_PATHS = {
    "chrome": [
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
    ],
    "msedge": [
        r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
        r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    ],
}
_ORDER = {"fail": 0, "warn": 1, "ok": 2, "info": 3}


class Report:
    """Conta os problemas e repassa cada item para a tela (preta ou janela)."""

    def __init__(self, ui: ToolUI | None = None) -> None:
        self.ui = ui or ConsoleUI()
        self.errors = 0
        self.warnings = 0

    def section(self, title: str) -> None:
        self.ui.section(title)

    def info(self, msg: str, badge: str = "") -> None:
        self.ui.info(msg, badge)

    def ok(self, msg: str, badge: str = "") -> None:
        self.ui.ok(msg, badge)

    def warn(self, msg: str, badge: str = "") -> None:
        self.warnings += 1
        self.ui.warn(msg, badge)

    def fail(self, msg: str, badge: str = "") -> None:
        self.errors += 1
        self.ui.fail(msg, badge)

    def add(self, level: str, msg: str, badge: str = "") -> None:
        getattr(self, level)(msg, badge)


def check_browser(settings: Settings, r: Report) -> None:
    if settings.browser_channel == "chromium":
        r.ok("Navegador: Chromium do Playwright")
        return
    for raw in _CHROME_PATHS.get(settings.browser_channel, []):
        path = Path(os.path.expandvars(raw))
        if path.is_file():
            r.ok("Google Chrome instalado" if settings.browser_channel == "chrome" else f"Navegador: {path}")
            return
    r.fail(f"Navegador '{settings.browser_channel}' não encontrado. Instale o Google Chrome.")


def check_downloads(settings: Settings, r: Report) -> None:
    base = settings.downloads_dir
    try:
        DownloadOrganizer(base).check_available()
        probe = base / f".teste-{uuid.uuid4().hex}.tmp"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except (DownloadFolderUnavailable, OSError) as exc:
        r.fail(f"Pasta das notas inacessível: {base} ({exc})")
        return
    r.ok(f"Pasta das notas: {base}")


def check_task(r: Report) -> None:
    if sys.platform != "win32":
        return
    proc = subprocess.run(  # noqa: S603
        ["schtasks", "/Query", "/TN", TASK_NAME], capture_output=True, text=True, check=False
    )
    if proc.returncode == 0:
        r.ok("Início automático com o Windows configurado")
    else:
        r.warn("Início automático NÃO configurado (execute o instalador de novo).")


def check_robot(settings: Settings, r: Report) -> None:
    from app import __version__
    from app.tray import read_local_status, read_update_status

    state, dry_run = read_local_status(settings.status_file)
    robot = {"idle": "Robô ligado, aguardando", "busy": "Robô ligado, trabalhando no SIAT"}.get(state, "Robô parado")
    (r.ok if state != "stopped" else r.warn)(robot, badge=f"versão {__version__}")
    newer = read_update_status(settings)
    if newer:
        r.info("Versão nova disponível: o robô instala sozinho quando estiver parado", badge=newer)
    if dry_run or settings.automation_dry_run:
        r.warn("Modo de teste (dry-run) ligado: nada será agendado no SIAT.")


async def check_supabase_and_certs(settings: Settings, r: Report) -> dict[str, int]:
    """Ativação, conexão com o painel e certificados. -> contagem {"ok", "bad", "warn"} dos certificados."""
    counts = {"ok": 0, "bad": 0, "warn": 0}
    if settings.auth_mode is None:
        r.fail("Computador não ativado. Menu Iniciar → JR Sistema → Ativar este computador.")
        return counts
    if settings.auth_mode == "service":
        r.warn("Usando a chave-mestra (instalação antiga). Ative este computador com um código do painel.")
    else:
        r.ok("Computador ativado no painel")
    from app.services.supabase_client import get_supabase

    try:
        sb = await get_supabase(settings)
        clients = (
            await sb.table("clients").select("id, client_code, legal_name").eq("active", True).order("client_code").execute()
        ).data
        certs = (
            await sb.table("certificates")
            .select("client_id, subject_name, thumbprint, serial_number, valid_until, requires_manual_selection")
            .eq("active", True)
            .execute()
        ).data
    except Exception as exc:  # noqa: BLE001
        r.fail(f"Não foi possível conectar ao painel: {exc}")
        return counts
    r.ok("Conectado ao painel", badge=f"{len(clients)} cliente(s) ativo(s)")

    store = await list_user_certificates()
    by_client = {c["client_id"]: c for c in certs}
    now = datetime.now(timezone.utc)
    rows: list[tuple[str, str, str]] = []  # (nível, cliente, etiqueta)
    for client in clients:
        label = f"{client['client_code']} {client['legal_name']}"
        cert = by_client.get(client["id"])
        if cert is None:
            rows.append(("warn", label, "sem certificado no painel"))
            continue
        until = datetime.fromisoformat(cert["valid_until"].replace("Z", "+00:00"))
        if until < now:
            rows.append(("fail", label, f"vencido em {until:%d/%m/%Y}"))
            continue
        found = find_in_store(store, thumbprint=cert.get("thumbprint"), serial_number=cert.get("serial_number"))
        if found is None:
            if not cert.get("thumbprint") and not cert.get("serial_number"):
                rows.append(("warn", label, "sem thumbprint/série: não dá para conferir"))
            else:
                rows.append(("fail", label, "não instalado neste Windows"))
        elif not found.has_private_key:
            rows.append(("fail", label, "instalado sem chave privada"))
        else:
            rows.append(("ok", label, f"válido até {until:%d/%m/%Y}"))
    r.section(f"Certificados dos clientes ({len(clients)})")
    for level, label, badge in sorted(rows, key=lambda x: _ORDER[x[0]]):  # problemas primeiro
        r.add(level, label, badge)
        counts["bad" if level == "fail" else level] += 1
    return counts


def run_checks(settings: Settings, ui: ToolUI) -> int:
    """Todas as verificações, com o resumo no topo. -> quantos problemas a corrigir."""
    ui.summary("info", "Verificando…", "Robô, este computador e os certificados dos clientes.")
    r = Report(ui)
    r.section("Robô")
    check_robot(settings, r)
    r.section("Este computador")
    check_browser(settings, r)
    check_downloads(settings, r)
    check_task(r)
    certs = asyncio.run(check_supabase_and_certs(settings, r))

    parts: list[str] = []
    if certs["ok"] or certs["bad"] or certs["warn"]:
        parts.append(f"{certs['ok']} certificado(s) ok")
        if certs["bad"]:
            parts.append(f"{certs['bad']} com problema")
        if certs["warn"]:
            parts.append(f"{certs['warn']} sem cadastro completo")
    if r.errors:
        hint = "Instale o .pfx dos clientes marcados com ✖, com o mesmo usuário do Windows que roda o robô."
        if r.errors > certs["bad"]:
            hint = "Corrija os itens marcados com ✖ e verifique de novo."
        ui.summary("fail", f"{r.errors} problema(s) a corrigir", " · ".join(parts + [hint]))
    elif r.warnings:
        ui.summary("warn", "Pronto, com avisos", " · ".join(parts) or "Veja os itens marcados com !.")
    else:
        ui.summary("ok", "Tudo pronto", " · ".join(parts) or "Este computador está pronto para rodar o robô.")
    return r.errors


def run_gui() -> int:
    from app.tools.gui import run_in_window

    def work(ui: ToolUI) -> int:
        settings = get_settings()
        ui.status("Verificando…")
        errors = run_checks(settings, ui)
        actions = [("Abrir painel", lambda: os.startfile(settings.panel_url))]  # noqa: S606
        log_file = settings.log_file
        if log_file is not None and log_file.is_file():
            actions.insert(0, ("Ver mensagens do robô (log)", lambda: os.startfile(log_file)))  # noqa: S606
        if errors:
            ui.done(False, "Verificação concluída", "Depois de corrigir, abra o Status e verificação de novo.", actions)
            return 1
        ui.done(True, "Verificação concluída", "Este computador está pronto para rodar o robô.", actions)
        return 0

    return run_in_window(TITLE, SUBTITLE, work, height=640)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Confere se este computador está pronto para rodar o robô.")
    parser.add_argument("--gui", action="store_true", help="janela em vez da tela preta")
    args = parser.parse_args(argv)
    if args.gui:
        return run_gui()
    print()
    print("Verificação do robô SIAT neste computador")
    print("=" * 50)
    errors = run_checks(get_settings(), ConsoleUI())
    print()
    if errors:
        print(f"Resultado: {errors} problema(s) a corrigir.")
        return 1
    print("Resultado: tudo pronto.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
