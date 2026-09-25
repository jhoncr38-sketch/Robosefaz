r"""Abre o SIAT no perfil de um cliente com o Playwright Inspector (calibração de seletores).

Uso:
    .venv\Scripts\python.exe -m app.tools.inspect_siat --client-code CLI000001

O navegador abre no perfil exclusivo do cliente e o Inspector permite gravar
a rotina (botão "Record") e copiar localizadores para
worker/config/siat_selectors.json. Nenhuma ação é executada automaticamente.
"""

from __future__ import annotations

import argparse
import asyncio

from app.browser.browser_factory import BrowserOptions, BrowserSession
from app.certificates.certificate_profile import CertificateProfile
from app.config import get_settings
from app.jobs.models import Certificate, Client
from app.services.supabase_client import get_supabase


async def run(client_code: str) -> None:
    settings = get_settings()
    sb = await get_supabase(settings)
    res = await sb.table("clients").select("*").eq("client_code", client_code).limit(1).execute()
    if not res.data:
        raise SystemExit(f"Cliente {client_code} não encontrado")
    client = Client.model_validate(res.data[0])
    cert_res = await sb.table("certificates").select("*").eq("client_id", client.id).eq("active", True).limit(1).execute()
    certificate = Certificate.model_validate(cert_res.data[0]) if cert_res.data else None

    profile = CertificateProfile(settings.profiles_dir, client, certificate)
    user_data_dir, _ = profile.prepare()
    options = BrowserOptions.from_settings(settings, user_data_dir, profile.downloads_tmp_dir, owner="inspect")
    options.headless = False
    async with BrowserSession(options) as session:
        assert session.page is not None
        await session.page.goto(settings.siat_login_url)
        print("Inspector aberto. Feche a janela do Inspector (ou clique em Resume) para encerrar.")
        await session.page.pause()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-code", required=True)
    args = parser.parse_args()
    asyncio.run(run(args.client_code))


if __name__ == "__main__":
    main()
