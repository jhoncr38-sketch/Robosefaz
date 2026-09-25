"""Dependências da API: autenticação via JWT do Supabase e controle de papéis."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx
from fastapi import Depends, Header, HTTPException, status

from app.config import Settings, get_settings
from app.jobs.repository import JobRepository, SupabaseJobRepository
from app.services.supabase_client import SupabaseNotConfigured, get_supabase

ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}


@dataclass(slots=True)
class CurrentUser:
    id: str
    email: str
    name: str
    role: str
    token: str

    def has_role(self, minimum: str) -> bool:
        return ROLE_LEVEL.get(self.role, 0) >= ROLE_LEVEL[minimum]


def settings_dep() -> Settings:
    return get_settings()


async def repo_dep(settings: Settings = Depends(settings_dep)) -> JobRepository:
    try:
        return SupabaseJobRepository(await get_supabase(settings))
    except SupabaseNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


async def current_user(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(settings_dep),
) -> CurrentUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token ausente", headers={"WWW-Authenticate": "Bearer"})
    token = authorization.split(" ", 1)[1].strip()
    try:
        sb = await get_supabase(settings)
    except SupabaseNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    try:
        resp = await sb.auth.get_user(token)
    except Exception as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão inválida ou expirada") from exc
    user = resp.user if resp else None
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão inválida ou expirada")
    res = await sb.table("profiles").select("name,email,role,active").eq("user_id", user.id).limit(1).execute()
    if not res.data or not res.data[0].get("active"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Usuário inativo ou sem perfil")
    p = res.data[0]
    return CurrentUser(id=user.id, email=p.get("email") or user.email or "", name=p.get("name") or "", role=p["role"], token=token)


def require_role(minimum: str) -> Callable[..., Awaitable[CurrentUser]]:
    async def _dep(user: CurrentUser = Depends(current_user)) -> CurrentUser:
        if not user.has_role(minimum):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Permissão insuficiente (requer {minimum})")
        return user

    return _dep


require_viewer = require_role("viewer")
require_operator = require_role("operator")
require_admin = require_role("admin")


_PG_STATUS = {"42501": 403, "P0002": 404, "22023": 400, "23505": 409}


async def user_rpc(settings: Settings, user: CurrentUser, fn: str, params: dict[str, Any]) -> Any:
    """Executa uma RPC no PostgREST com o JWT do usuário (RLS e auth.uid() aplicados)."""
    if not settings.supabase_anon_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "SUPABASE_ANON_KEY não configurada no worker")
    url = settings.supabase_url.rstrip("/") + f"/rest/v1/rpc/{fn}"
    headers = {
        "apikey": settings.supabase_anon_key,
        "Authorization": f"Bearer {user.token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(url, json=params, headers=headers)
    if r.status_code >= 400:
        try:
            body = r.json()
        except ValueError:
            body = {"message": r.text}
        code = body.get("code", "")
        raise HTTPException(_PG_STATUS.get(code, 400), body.get("message") or "Erro no banco de dados")
    return r.json() if r.content else None
