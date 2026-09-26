"""Perfil de navegador do cliente (configuração assistida) e arquivos baixados."""

from __future__ import annotations


from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, require_admin, require_viewer, settings_dep
from app.clients.profile_setup import profile_setup_service
from app.config import Settings
from app.downloads.organizer import DownloadOrganizer
from app.jobs.models import Certificate, Client
from app.services.supabase_client import get_supabase

router = APIRouter(tags=["clients"])


@router.post("/clients/{client_id}/browser-profile/open")
async def open_browser_profile(
    client_id: str,
    user: CurrentUser = Depends(require_admin),
    settings: Settings = Depends(settings_dep),
) -> dict:
    sb = await get_supabase(settings)
    res = await sb.table("clients").select("*").eq("id", client_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cliente não encontrado")
    client = Client.model_validate(res.data[0])
    running = (
        await sb.table("automation_jobs")
        .select("id")
        .eq("client_id", client_id)
        .not_.is_("locked_by", "null")
        .limit(1)
        .execute()
    )
    if running.data:
        raise HTTPException(status.HTTP_409_CONFLICT, "Há uma automação em execução para este cliente")
    cert_res = (
        await sb.table("certificates").select("*").eq("client_id", client_id).eq("active", True).limit(1).execute()
    )
    certificate = Certificate.model_validate(cert_res.data[0]) if cert_res.data else None
    session = profile_setup_service.start(settings, client, certificate)
    await sb.table("audit_logs").insert(
        {"user_id": user.id, "action": "browser_profile.opened", "entity": "client", "entity_id": client_id,
         "client_id": client_id, "data": {}}
    ).execute()
    return session.to_dict()


@router.get("/clients/{client_id}/browser-profile")
async def browser_profile_status(client_id: str, _user: CurrentUser = Depends(require_viewer)) -> dict:
    session = profile_setup_service.get(client_id)
    return session.to_dict() if session else {"client_id": client_id, "status": "idle", "message": ""}


@router.get("/downloads/{download_id}/file")
async def download_file(
    download_id: str,
    _user: CurrentUser = Depends(require_viewer),
    settings: Settings = Depends(settings_dep),
) -> FileResponse:
    sb = await get_supabase(settings)
    res = await sb.table("downloads").select("*, clients(client_code)").eq("id", download_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Download não encontrado")
    row = res.data[0]
    client_code = (row.get("clients") or {}).get("client_code") or ""
    try:
        path = DownloadOrganizer(settings.downloads_dir).locate(
            row["filepath"], client_code, row["competence"], row["document_type"], row["filename"]
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Arquivo fora do diretório de downloads") from exc
    if not path.is_file():
        raise HTTPException(
            status.HTTP_410_GONE,
            "Arquivo não está neste computador. Ele fica na pasta de downloads do computador que fez o "
            "agendamento.",
        )
    return FileResponse(path, media_type="application/zip", filename=row["filename"])
