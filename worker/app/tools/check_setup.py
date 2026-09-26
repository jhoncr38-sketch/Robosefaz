r"""Confere se este computador está pronto para rodar o robô.

    .venv\Scripts\python.exe -m app.tools.check_setup

Verifica (somente leitura, nada é alterado no Supabase nem no SIAT):
1. configuração do .env (Supabase);
2. conexão com o Supabase;
3. Google Chrome instalado;
4. pasta de downloads acessível e gravável;
5. certificados A1 dos clientes ativos instalados no Windows deste usuário;
6. tarefa agendada que inicia o robô junto com o Windows.

Código de saída 1 se algum item obrigatório falhar.
"""

from __future__ import annotations

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

TASK_NAME = "SIAT Automacao - Robo"

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


class Report:
    def __init__(self) -> None:
        self.errors = 0

    def ok(self, msg: str) -> None:
        print(f"  [OK]       {msg}")

    def warn(self, msg: str) -> None:
        print(f"  [ATENCAO]  {msg}")

    def fail(self, msg: str) -> None:
        self.errors += 1
        print(f"  [ERRO]     {msg}")


def check_browser(settings: Settings, r: Report) -> None:
    if settings.browser_channel == "chromium":
        r.ok("Navegador: Chromium do Playwright")
        return
    for raw in _CHROME_PATHS.get(settings.browser_channel, []):
        path = Path(os.path.expandvars(raw))
        if path.is_file():
            r.ok(f"Navegador encontrado: {path}")
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
        r.fail(f"Pasta de downloads inacessível: {base} ({exc})")
        return
    r.ok(f"Pasta de downloads: {base}")


def check_task(r: Report) -> None:
    if sys.platform != "win32":
        return
    proc = subprocess.run(  # noqa: S603
        ["schtasks", "/Query", "/TN", TASK_NAME], capture_output=True, text=True, check=False
    )
    if proc.returncode == 0:
        r.ok(f"Início automático configurado (tarefa '{TASK_NAME}')")
    else:
        r.warn("Início automático NÃO configurado (rode instalar-robo.bat).")


async def check_supabase_and_certs(settings: Settings, r: Report) -> None:
    if not settings.supabase_configured:
        r.fail("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não preenchidos no .env")
        return
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
        r.fail(f"Não foi possível conectar ao Supabase: {exc}")
        return
    r.ok(f"Supabase conectado ({len(clients)} cliente(s) ativo(s))")

    store = await list_user_certificates()
    by_client = {c["client_id"]: c for c in certs}
    now = datetime.now(timezone.utc)
    print()
    print("  Certificados dos clientes neste Windows:")
    for client in clients:
        label = f"{client['client_code']} {client['legal_name']}"
        cert = by_client.get(client["id"])
        if cert is None:
            r.warn(f"{label}: nenhum certificado cadastrado no painel")
            continue
        until = datetime.fromisoformat(cert["valid_until"].replace("Z", "+00:00"))
        if until < now:
            r.fail(f"{label}: certificado VENCIDO em {until:%d/%m/%Y}")
            continue
        found = find_in_store(store, thumbprint=cert.get("thumbprint"), serial_number=cert.get("serial_number"))
        if found is None:
            if not cert.get("thumbprint") and not cert.get("serial_number"):
                r.warn(f"{label}: cadastro sem thumbprint/série; não dá para conferir a instalação")
            else:
                r.fail(f"{label}: certificado NÃO instalado neste Windows (instale o .pfx deste cliente)")
        elif not found.has_private_key:
            r.fail(f"{label}: certificado instalado SEM chave privada (reinstale a partir do .pfx)")
        else:
            r.ok(f"{label}: instalado, válido até {until:%d/%m/%Y}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    settings = get_settings()
    r = Report()
    print()
    print("Verificação do robô SIAT neste computador")
    print("=" * 50)
    print(f"  Modo de teste (dry-run): {'LIGADO - nada será agendado' if settings.automation_dry_run else 'desligado'}")
    check_browser(settings, r)
    check_downloads(settings, r)
    check_task(r)
    asyncio.run(check_supabase_and_certs(settings, r))
    print()
    if r.errors:
        print(f"Resultado: {r.errors} problema(s) a corrigir.")
        return 1
    print("Resultado: tudo pronto.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
