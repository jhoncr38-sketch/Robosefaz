"""Cliente Supabase compartilhado pelo worker e pela API.

- Computador ativado (DEVICE_EMAIL): entra com o login técnico do computador;
  o banco só entrega os dados do escritório dele.
- Instalação antiga (SUPABASE_SERVICE_ROLE_KEY): chave-mestra, até ser ativada.
"""

from __future__ import annotations

import asyncio
import logging

from supabase import AsyncClient, Client, acreate_client, create_client

from app.config import Settings, get_settings

log = logging.getLogger("supabase")

_client: AsyncClient | None = None
_lock = asyncio.Lock()


class SupabaseNotConfigured(RuntimeError):
    pass


async def _new_client(settings: Settings) -> AsyncClient:
    mode = settings.auth_mode
    if mode == "device":
        from app.services.device_auth import device_credentials

        client = await acreate_client(settings.supabase_url, settings.supabase_anon_key)
        await client.auth.sign_in_with_password(device_credentials(settings))
        return client
    if mode == "service":
        return await acreate_client(settings.supabase_url, settings.supabase_service_role_key)
    raise SupabaseNotConfigured(
        "Este computador não está ativado. Ative-o com o código gerado em Computadores, no painel."
    )


async def get_supabase(settings: Settings | None = None) -> AsyncClient:
    global _client
    settings = settings or get_settings()
    if _client is not None:
        return _client
    async with _lock:
        if _client is None:
            _client = await _new_client(settings)
    return _client


async def keep_session_alive(settings: Settings | None = None) -> None:
    """Renova o acesso do computador (expira a cada hora); se falhar, entra de novo."""
    settings = settings or get_settings()
    if settings.auth_mode != "device" or _client is None:
        return
    try:
        await _client.auth.refresh_session()
    except Exception as exc:  # noqa: BLE001
        log.warning("Renovação do acesso falhou (%s); entrando de novo.", exc)
        from app.services.device_auth import device_credentials

        await _client.auth.sign_in_with_password(device_credentials(settings))


def create_sync_client(settings: Settings | None = None) -> Client:
    """Cliente síncrono (ícone da bandeja, botão Abrir pasta)."""
    settings = settings or get_settings()
    mode = settings.auth_mode
    if mode == "device":
        from app.services.device_auth import device_credentials

        client = create_client(settings.supabase_url, settings.supabase_anon_key)
        client.auth.sign_in_with_password(device_credentials(settings))
        return client
    if mode == "service":
        return create_client(settings.supabase_url, settings.supabase_service_role_key)
    raise SupabaseNotConfigured("Este computador não está ativado.")


def reset_supabase_client() -> None:
    global _client
    _client = None
