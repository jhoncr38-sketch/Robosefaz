"""Endpoints de jobs: listar, detalhar, criar, reprocessar, cancelar, confirmar intervenção."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import CurrentUser, require_admin, require_operator, require_viewer, settings_dep, user_rpc
from app.api.schemas import ClientAutomationRequest, CreateJobsRequest
from app.config import Settings
from app.services.supabase_client import get_supabase

router = APIRouter(tags=["jobs"])


@router.get("/jobs")
async def list_jobs(
    status_filter: str | None = Query(default=None, alias="status"),
    client_id: str | None = None,
    competence: str | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    _user: CurrentUser = Depends(require_viewer),
    settings: Settings = Depends(settings_dep),
) -> list[dict]:
    sb = await get_supabase(settings)
    q = sb.table("automation_jobs").select("*, clients(client_code, legal_name, trade_name, cnpj)")
    if status_filter:
        q = q.eq("status", status_filter)
    if client_id:
        q = q.eq("client_id", client_id)
    if competence:
        q = q.eq("competence", competence)
    res = await q.order("created_at", desc=True).limit(limit).execute()
    return res.data or []


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    _user: CurrentUser = Depends(require_viewer),
    settings: Settings = Depends(settings_dep),
) -> dict:
    sb = await get_supabase(settings)
    res = (
        await sb.table("automation_jobs")
        .select("*, clients(client_code, legal_name, trade_name, cnpj)")
        .eq("id", job_id)
        .limit(1)
        .execute()
    )
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job não encontrado")
    tasks = await sb.table("automation_tasks").select("*").eq("job_id", job_id).order("created_at").execute()
    logs = (
        await sb.table("automation_logs").select("*").eq("job_id", job_id).order("created_at").limit(1000).execute()
    )
    downloads = await sb.table("downloads").select("*").eq("job_id", job_id).execute()
    return {**res.data[0], "tasks": tasks.data or [], "logs": logs.data or [], "downloads": downloads.data or []}


@router.post("/jobs", status_code=status.HTTP_201_CREATED)
async def create_jobs(
    body: CreateJobsRequest,
    user: CurrentUser = Depends(require_operator),
    settings: Settings = Depends(settings_dep),
) -> list[dict]:
    if body.force and not user.has_role("admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Somente administradores podem forçar novo agendamento")
    return await user_rpc(
        settings,
        user,
        "create_automation_jobs_batch",
        {
            "p_client_ids": body.client_ids,
            "p_competence": body.competence,
            "p_operations": [op.value for op in body.operations],
            "p_force": body.force,
            "p_respect_client_flags": body.respect_client_flags,
        },
    )


@router.post("/clients/{client_id}/automation", status_code=status.HTTP_201_CREATED)
async def client_automation(
    client_id: str,
    body: ClientAutomationRequest,
    user: CurrentUser = Depends(require_operator),
    settings: Settings = Depends(settings_dep),
) -> dict:
    if body.force and not user.has_role("admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Somente administradores podem forçar novo agendamento")
    return await user_rpc(
        settings,
        user,
        "create_automation_job",
        {
            "p_client_id": client_id,
            "p_competence": body.competence,
            "p_operations": [op.value for op in body.operations],
            "p_force": body.force,
        },
    )


@router.post("/jobs/{job_id}/retry")
async def retry_job(
    job_id: str, user: CurrentUser = Depends(require_admin), settings: Settings = Depends(settings_dep)
) -> dict:
    return await user_rpc(settings, user, "retry_automation_job", {"p_job_id": job_id})


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: str, user: CurrentUser = Depends(require_operator), settings: Settings = Depends(settings_dep)
) -> dict:
    return await user_rpc(settings, user, "cancel_automation_job", {"p_job_id": job_id})


@router.post("/jobs/{job_id}/confirm")
async def confirm_manual_action(
    job_id: str, user: CurrentUser = Depends(require_operator), settings: Settings = Depends(settings_dep)
) -> dict:
    return await user_rpc(settings, user, "confirm_manual_action", {"p_job_id": job_id})
