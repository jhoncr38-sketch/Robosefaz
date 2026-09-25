r"""Testa se o Chrome desta máquina aceita a política AutoSelectCertificateForUrls.

Execute em um PowerShell aberto como ADMINISTRADOR:

    cd worker
    .venv\Scripts\python.exe -m app.tools.test_chrome_policy --client-code CLI000001

O teste:
1. grava a regra (somente para o certificado do cliente informado);
2. abre o Chrome com um perfil TEMPORÁRIO (sem sessão salva) e confere a
   política em chrome://policy;
3. faz o login no SIAT com o mesmo código do robô, esperando que o certificado
   seja escolhido sozinho, sem a janela "Selecione um certificado";
4. remove a regra do Registro e apaga o perfil temporário.

Nada é agendado nem alterado no SIAT: apenas login.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.automation.base import AutomationContext
from app.automation.siat.siat_login import SiatLogin
from app.browser.browser_factory import BrowserOptions, BrowserSession
from app.certificates.chrome_policy import ChromeCertificatePolicyService
from app.config import get_settings
from app.downloads.organizer import DownloadOrganizer
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Certificate, Client, Job, LogLevel
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger
from app.services.supabase_client import get_supabase

WAIT_SECONDS = 30


def is_admin() -> bool:
    if sys.platform != "win32":
        return True
    import ctypes

    return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]


class _ConsoleRepo:
    async def add_log(self, *, level: LogLevel, message: str, **_: Any) -> None:
        print(f"   [{level.value}] {message}")


class _TestReporter:
    """Reporter do teste: se o robô precisar de ajuda, a política NÃO funcionou."""

    async def step(self, status: JobStatus, message: str | None = None) -> None:
        print(f" -> {message or status.value}")

    async def check_cancel(self) -> None:
        return None

    async def screenshot(self, step: str) -> None:
        return None

    async def wait_for_user_confirmation(
        self,
        message: str,
        *,
        status: JobStatus = JobStatus.MANUAL_ACTION_REQUIRED,
        resolved: Callable[[], Awaitable[bool]] | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        print(f" !! O robô pediria intervenção: {message}")
        print(f"    Aguardando {WAIT_SECONDS}s para ver se o login conclui sozinho (NÃO escolha o certificado)...")
        for _ in range(WAIT_SECONDS * 2):
            if resolved is not None and await resolved():
                return
            await asyncio.sleep(0.5)
        raise AutomationError(
            ErrorCode.MANUAL_ACTION_REQUIRED,
            "O certificado não foi escolhido automaticamente (a janela nativa apareceu).",
        )


async def run(client_code: str) -> int:
    settings = get_settings()
    if not is_admin():
        print("ERRO: execute este teste em um PowerShell aberto como ADMINISTRADOR.")
        print("A regra do Chrome fica em HKCU\\Software\\Policies, que só administradores podem gravar.")
        return 2

    sb = await get_supabase(settings)
    res = await sb.table("clients").select("*").eq("client_code", client_code).limit(1).execute()
    if not res.data:
        print(f"Cliente {client_code} não encontrado.")
        return 1
    client = Client.model_validate(res.data[0])
    cert_res = (
        await sb.table("certificates").select("*").eq("client_id", client.id).eq("active", True).limit(1).execute()
    )
    if not cert_res.data:
        print("Cliente sem certificado ativo.")
        return 1
    certificate = Certificate.model_validate(cert_res.data[0])

    service = ChromeCertificatePolicyService(
        channel=settings.browser_channel,
        allow_write=True,
        state_file=settings.profiles_dir / "_chrome_policy_state.json",
    )
    entry = service.entry_for_certificate(certificate, settings.chrome_policy_pattern)
    print(f"Cliente: {client.display_name} ({client.client_code})")
    print(f"Regra:   HKCU\\{service.key_path}")
    print(f"Valor:   {entry.to_policy_json()}\n")

    tmp = Path(tempfile.mkdtemp(prefix="siat-policy-test-"))
    ok_policy = False
    ok_login = False
    last_url = ""
    error_text = ""
    try:
        async with service.applied_for_job(certificate, settings.chrome_policy_pattern) as created:
            print(f"1) Regra gravada no Registro (valor {', '.join(created) or 'já existente'}).")
            options = BrowserOptions.from_settings(settings, tmp / "chrome", tmp / "downloads", owner="policy-test")
            options.headless = False
            async with BrowserSession(options) as session:
                page = session.page
                assert page is not None
                await page.goto("chrome://policy")
                # a página usa web components (shadow DOM); os localizadores de
                # texto do Playwright atravessam o shadow DOM, innerText não.
                try:
                    await page.get_by_text("AutoSelectCertificateForUrls").first.wait_for(timeout=8_000)
                    ok_policy = True
                except Exception:
                    ok_policy = False
                print(f"2) chrome://policy mostra a regra: {'SIM' if ok_policy else 'NÃO'}")

                repo = _ConsoleRepo()
                ctx = AutomationContext(
                    job=Job(
                        id="teste-politica",
                        client_id=client.id,
                        competence="2026-08",
                        start_date=date(2026, 8, 1),
                        end_date=date(2026, 8, 31),
                    ),
                    client=client,
                    certificate=certificate.model_copy(update={"requires_manual_selection": False}),
                    settings=settings,
                    reporter=_TestReporter(),
                    logger=JobLogger(repo, None),  # type: ignore[arg-type]
                    organizer=DownloadOrganizer(settings.downloads_dir),
                    page=page,
                )
                print("3) Login no SIAT com o código do robô...")
                try:
                    await SiatLogin(ctx).login()
                    ok_login = True
                    last_url = ctx.page.url if ctx.page else ""
                    print(f"   Login concluído sem intervenção. URL: {ctx.page.url if ctx.page else '?'}")
                except AutomationError as exc:
                    error_text = f"[{exc.code}] {exc.message}"
                    last_url = ctx.page.url if ctx.page else ""
                    print(f"   Falhou: {error_text}")
        print("4) Regra removida do Registro.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    result_file = settings.profiles_dir.parent / "policy_test_result.json"
    result_file.write_text(
        json.dumps(
            {
                "at": datetime.now().isoformat(timespec="seconds"),
                "client_code": client.client_code,
                "channel": settings.browser_channel,
                "policy_visible_in_chrome": ok_policy,
                "login_without_dialog": ok_login,
                "last_url": last_url,
                "error": error_text,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print()
    if ok_login:
        print("RESULTADO: a opção B FUNCIONA nesta máquina.")
        print("Inicie o worker sempre em um PowerShell de ADMINISTRADOR.")
        return 0
    if ok_policy:
        print("RESULTADO: o Chrome leu a regra, mas o login não concluiu sozinho.")
        print("Envie esta saída para análise (pode ser o texto do botão de login ou o filtro do certificado).")
    else:
        print("RESULTADO: o Chrome NÃO aplicou a regra de HKCU nesta máquina. Use a opção A (manual).")
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Testa a política AutoSelectCertificateForUrls")
    parser.add_argument("--client-code", required=True)
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    raise SystemExit(asyncio.run(run(args.client_code)))


if __name__ == "__main__":
    main()
