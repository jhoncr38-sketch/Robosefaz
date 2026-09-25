"""Cliente Supabase assíncrono (service role) compartilhado pelo worker e pela API."""

from __future__ import annotations

import asyncio

from supabase import AsyncClient, acreate_client

from app.config import Settings, get_settings

_client: AsyncClient | None = None
_lock = asyncio.Lock()


class SupabaseNotConfigured(RuntimeError):
    pass


async def get_supabase(settings: Settings | None = None) -> AsyncClient:
    global _client
    settings = settings or get_settings()
    if not settings.supabase_configured:
        raise SupabaseNotConfigured("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar configurados")
    if _client is not None:
        return _client
    async with _lock:
        if _client is None:
            _client = await acreate_client(settings.supabase_url, settings.supabase_service_role_key)
    return _client


def reset_supabase_client() -> None:
    global _client
    _client = None
