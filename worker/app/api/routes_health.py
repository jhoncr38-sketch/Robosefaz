"""GET /health e GET /worker/status."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.api.deps import CurrentUser, require_viewer, settings_dep
from app.api.schemas import HealthResponse
from app.browser.browser_factory import check_browser_available
from app.config import Settings
from app.jobs.repository import SupabaseJobRepository
from app.services.supabase_client import get_supabase

router = APIRouter(tags=["health"])

_browser_cache: dict[str, float | bool] = {"at": 0.0, "ok": False}
BROWSER_CACHE_SECONDS = 300


async def _browser_ok(settings: Settings) -> bool:
    now = time.monotonic()
    if now - float(_browser_cache["at"]) < BROWSER_CACHE_SECONDS and _browser_cache["at"]:
        return bool(_browser_cache["ok"])
    ok = await check_browser_available(settings)
    _browser_cache.update(at=now, ok=ok)
    return ok


async def _database_ok(settings: Settings) -> bool:
    if not settings.supabase_configured:
        return False
    try:
        repo = SupabaseJobRepository(await get_supabase(settings))
        return await repo.ping()
    except Exception:
        return False


@router.get("/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(settings_dep)) -> HealthResponse:
    browser = await _browser_ok(settings)
    database = await _database_ok(settings)
    return HealthResponse(status="ok" if browser and database else "degraded", browser=browser, database=database)


@router.get("/worker/status")
async def worker_status(
    _user: CurrentUser = Depends(require_viewer),
    settings: Settings = Depends(settings_dep),
) -> dict:
    sb = await get_supabase(settings)
    hb = await sb.table("worker_heartbeats").select("*").order("last_seen_at", desc=True).limit(20).execute()
    now = datetime.now(timezone.utc)
    workers = []
    for w in hb.data or []:
        seen = datetime.fromisoformat(w["last_seen_at"])
        w["online"] = w.get("status") != "stopped" and now - seen < timedelta(minutes=2)
        workers.append(w)

    counts: dict[str, int] = {}
    for st in ("queued", "waiting_sefaz", "manual_action_required", "waiting_certificate", "failed"):
        res = await sb.table("automation_jobs").select("id", count="exact").eq("status", st).limit(1).execute()
        counts[st] = res.count or 0

    return {
        "online": any(w["online"] for w in workers),
        "workers": workers,
        "queue": counts,
        "config": {
            "dry_run": settings.automation_dry_run,
            "headless": settings.automation_headless,
            "max_parallel_jobs": settings.max_parallel_jobs,
            "browser_channel": settings.browser_channel,
            "screenshots": settings.automation_screenshots,
            "chrome_policy_mode": settings.chrome_policy_mode,
            "siat_base_url": settings.siat_base_url,
        },
    }
