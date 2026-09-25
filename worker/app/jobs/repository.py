"""Acesso a dados dos jobs.

`JobRepository` é o contrato usado pelos runners; `SupabaseJobRepository`
implementa via PostgREST (service role). Os testes usam um repositório em
memória com o mesmo contrato.
"""

from __future__ import annotations

import socket
from datetime import datetime, timezone
from typing import Any, Protocol

from supabase import AsyncClient
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

import httpx

from app.jobs.models import Certificate, Client, DocumentType, Job, LogLevel, Task, TaskStatus, TaskType


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


class JobRepository(Protocol):
    async def claim_next_job(self, worker_id: str) -> Job | None: ...
    async def claim_next_collection(self, worker_id: str) -> Job | None: ...
    async def get_job(self, job_id: str) -> Job | None: ...
    async def get_client(self, client_id: str) -> Client | None: ...
    async def get_active_certificate(self, client_id: str) -> Certificate | None: ...
    async def list_tasks(self, job_id: str) -> list[Task]: ...
    async def update_job(self, job_id: str, **fields: Any) -> None: ...
    async def update_task(self, task_id: str, **fields: Any) -> None: ...
    async def create_task(
        self,
        *,
        job_id: str,
        client_id: str,
        task_type: TaskType,
        competence: str,
        status: TaskStatus,
        document_type: DocumentType | None = None,
        result: dict[str, Any] | None = None,
    ) -> Task: ...
    async def find_active_export(self, dedup_key: str, exclude_task_id: str | None = None) -> Task | None: ...
    async def add_log(
        self,
        *,
        job_id: str | None,
        task_id: str | None,
        level: LogLevel,
        step: str | None,
        message: str,
        metadata: dict[str, Any],
    ) -> None: ...
    async def insert_download(self, **fields: Any) -> dict[str, Any]: ...
    async def get_download(self, download_id: str) -> dict[str, Any] | None: ...
    async def release_lock(self, job_id: str, worker_id: str) -> None: ...
    async def is_cancel_requested(self, job_id: str) -> bool: ...
    async def get_manual_confirmation(self, job_id: str) -> datetime | None: ...
    async def heartbeat(
        self, worker_id: str, kind: str, status: str, current_job_id: str | None, meta: dict[str, Any]
    ) -> None: ...
    async def release_stale_locks(self, minutes: int) -> int: ...
    async def refresh_certificate_statuses(self) -> int: ...
    async def generate_certificate_expiry_notifications(self) -> int: ...
    async def get_setting(self, key: str, default: Any = None) -> Any: ...
    async def ping(self) -> bool: ...


_transient = retry(
    reraise=True,
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=0.5, min=0.5, max=5),
    retry=retry_if_exception_type((httpx.TransportError, httpx.TimeoutException)),
)


def _serialize(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in fields.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif hasattr(v, "value") and not isinstance(v, (str, int, float, bool)):
            out[k] = v.value
        else:
            out[k] = v
    return out


class SupabaseJobRepository:
    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    # -- fila -------------------------------------------------------------
    @_transient
    async def claim_next_job(self, worker_id: str) -> Job | None:
        res = await self._db.rpc("claim_next_job", {"p_worker_id": worker_id}).execute()
        rows = res.data or []
        return Job.model_validate(rows[0]) if rows else None

    @_transient
    async def claim_next_collection(self, worker_id: str) -> Job | None:
        res = await self._db.rpc("claim_next_collection", {"p_worker_id": worker_id}).execute()
        rows = res.data or []
        return Job.model_validate(rows[0]) if rows else None

    @_transient
    async def release_lock(self, job_id: str, worker_id: str) -> None:
        await self._db.rpc("release_job_lock", {"p_job_id": job_id, "p_worker_id": worker_id}).execute()

    @_transient
    async def release_stale_locks(self, minutes: int) -> int:
        res = await self._db.rpc("release_stale_locks", {"p_stale_minutes": minutes}).execute()
        return int(res.data or 0)

    # -- leitura ----------------------------------------------------------
    @_transient
    async def get_job(self, job_id: str) -> Job | None:
        res = await self._db.table("automation_jobs").select("*").eq("id", job_id).limit(1).execute()
        return Job.model_validate(res.data[0]) if res.data else None

    @_transient
    async def get_client(self, client_id: str) -> Client | None:
        res = await self._db.table("clients").select("*").eq("id", client_id).limit(1).execute()
        return Client.model_validate(res.data[0]) if res.data else None

    @_transient
    async def get_active_certificate(self, client_id: str) -> Certificate | None:
        res = (
            await self._db.table("certificates")
            .select("*")
            .eq("client_id", client_id)
            .eq("active", True)
            .order("valid_until", desc=True)
            .limit(1)
            .execute()
        )
        return Certificate.model_validate(res.data[0]) if res.data else None

    @_transient
    async def list_tasks(self, job_id: str) -> list[Task]:
        res = (
            await self._db.table("automation_tasks")
            .select("*")
            .eq("job_id", job_id)
            .order("created_at")
            .execute()
        )
        return [Task.model_validate(r) for r in res.data or []]

    @_transient
    async def find_active_export(self, dedup_key: str, exclude_task_id: str | None = None) -> Task | None:
        q = (
            self._db.table("automation_tasks")
            .select("*")
            .eq("dedup_key", dedup_key)
            .eq("superseded", False)
            .in_("status", ["pending", "running", "scheduled", "processed", "downloaded", "completed"])
        )
        if exclude_task_id:
            q = q.neq("id", exclude_task_id)
        res = await q.limit(1).execute()
        return Task.model_validate(res.data[0]) if res.data else None

    @_transient
    async def is_cancel_requested(self, job_id: str) -> bool:
        res = (
            await self._db.table("automation_jobs")
            .select("cancel_requested,status")
            .eq("id", job_id)
            .limit(1)
            .execute()
        )
        if not res.data:
            return True
        row = res.data[0]
        return bool(row.get("cancel_requested")) or row.get("status") == "cancelled"

    @_transient
    async def get_manual_confirmation(self, job_id: str) -> datetime | None:
        res = (
            await self._db.table("automation_jobs")
            .select("manual_action_confirmed_at")
            .eq("id", job_id)
            .limit(1)
            .execute()
        )
        if not res.data or not res.data[0].get("manual_action_confirmed_at"):
            return None
        return datetime.fromisoformat(res.data[0]["manual_action_confirmed_at"])

    @_transient
    async def get_setting(self, key: str, default: Any = None) -> Any:
        res = await self._db.table("app_settings").select("value").eq("key", key).limit(1).execute()
        return res.data[0]["value"] if res.data else default

    @_transient
    async def get_download(self, download_id: str) -> dict[str, Any] | None:
        res = await self._db.table("downloads").select("*").eq("id", download_id).limit(1).execute()
        return res.data[0] if res.data else None

    # -- escrita ----------------------------------------------------------
    @_transient
    async def update_job(self, job_id: str, **fields: Any) -> None:
        if fields:
            await self._db.table("automation_jobs").update(_serialize(fields)).eq("id", job_id).execute()

    @_transient
    async def update_task(self, task_id: str, **fields: Any) -> None:
        if fields:
            await self._db.table("automation_tasks").update(_serialize(fields)).eq("id", task_id).execute()

    @_transient
    async def create_task(
        self,
        *,
        job_id: str,
        client_id: str,
        task_type: TaskType,
        competence: str,
        status: TaskStatus,
        document_type: DocumentType | None = None,
        result: dict[str, Any] | None = None,
    ) -> Task:
        payload = _serialize(
            {
                "job_id": job_id,
                "client_id": client_id,
                "task_type": task_type,
                "competence": competence,
                "status": status,
                "document_type": document_type,
                "result": result or {},
                "started_at": utcnow(),
            }
        )
        res = await self._db.table("automation_tasks").insert(payload).execute()
        return Task.model_validate(res.data[0])

    async def add_log(
        self,
        *,
        job_id: str | None,
        task_id: str | None,
        level: LogLevel,
        step: str | None,
        message: str,
        metadata: dict[str, Any],
    ) -> None:
        await self._db.table("automation_logs").insert(
            {
                "job_id": job_id,
                "task_id": task_id,
                "level": level.value,
                "step": step,
                "message": message,
                "metadata": metadata,
            }
        ).execute()

    @_transient
    async def insert_download(self, **fields: Any) -> dict[str, Any]:
        payload = _serialize(fields)
        res = (
            await self._db.table("downloads")
            .upsert(payload, on_conflict="client_id,competence,document_type,checksum")
            .execute()
        )
        return res.data[0] if res.data else payload

    async def heartbeat(
        self, worker_id: str, kind: str, status: str, current_job_id: str | None, meta: dict[str, Any]
    ) -> None:
        await self._db.table("worker_heartbeats").upsert(
            {
                "worker_id": worker_id,
                "kind": kind,
                "hostname": socket.gethostname(),
                "status": status,
                "current_job_id": current_job_id,
                "meta": meta,
                "last_seen_at": utcnow().isoformat(),
            },
            on_conflict="worker_id",
        ).execute()

    @_transient
    async def refresh_certificate_statuses(self) -> int:
        res = await self._db.rpc("refresh_certificate_statuses", {}).execute()
        return int(res.data or 0)

    @_transient
    async def generate_certificate_expiry_notifications(self) -> int:
        res = await self._db.rpc("generate_certificate_expiry_notifications", {}).execute()
        return int(res.data or 0)

    async def ping(self) -> bool:
        try:
            await self._db.table("app_settings").select("key").limit(1).execute()
            return True
        except Exception:
            return False
