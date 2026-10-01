"""Dublês de teste: repositório em memória e provider sem navegador."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, AsyncIterator, Callable

from app.automation.base import AutomationContext, AutomationProvider
from app.automation.registry import ProviderRegistry
from app.jobs.dedup import build_dedup_key
from app.jobs.models import (
    ACTIVE_TASK_STATUSES,
    TASK_DOCUMENT,
    Certificate,
    Client,
    DocumentType,
    DownloadedFile,
    ExportRequestResult,
    ExportStatus,
    ExportStatusResult,
    Job,
    LogLevel,
    Task,
    TaskStatus,
    TaskType,
)

CNPJ_OK = "11222333000181"


def now() -> datetime:
    return datetime.now(timezone.utc)


def make_client(**kw: Any) -> Client:
    data = {
        "id": str(uuid.uuid4()),
        "client_code": "CLI000001",
        "legal_name": "Empresa A LTDA",
        "trade_name": "Empresa A",
        "cnpj": CNPJ_OK,
        "state_registration": "123456789",
    }
    data.update(kw)
    return Client.model_validate(data)


def make_certificate(client: Client, **kw: Any) -> Certificate:
    data = {
        "id": str(uuid.uuid4()),
        "client_id": client.id,
        "subject_name": f"EMPRESA A LTDA:{client.cnpj}",
        "issuer": "CN=AC TESTE RFB v5, O=ICP-Brasil",
        "serial_number": "ABC123",
        "valid_from": now() - timedelta(days=100),
        "valid_until": now() + timedelta(days=200),
        "browser_profile": client.id,
    }
    data.update(kw)
    return Certificate.model_validate(data)


class FakeRepo:
    def __init__(self) -> None:
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, dict[str, Any]] = {}
        self.clients: dict[str, Client] = {}
        self.certificates: dict[str, Certificate] = {}
        self.logs: list[dict[str, Any]] = []
        self.downloads: list[dict[str, Any]] = []
        self.settings: dict[str, Any] = {}
        self.job_updates: list[tuple[str, dict[str, Any]]] = []
        self.released: list[str] = []
        self.heartbeats: list[dict[str, Any]] = []
        self.retention_calls: list[tuple] = []
        self.heartbeat_rows: dict[str, dict[str, Any]] = {}
        # outros computadores do escritório (hostname) para o repasse de trabalho sem certificado
        self.other_hosts: list[str] = []
        self.handovers: list[tuple[str, str, bool]] = []

    # -- setup helpers --------------------------------------------------------
    def add_client(self, client: Client, certificate: Certificate | None = None) -> None:
        self.clients[client.id] = client
        if certificate:
            self.certificates[client.id] = certificate

    def add_job(
        self,
        client: Client,
        operations: list[TaskType] | None = None,
        *,
        status: str = "queued",
        competence: str = "2026-08",
        attempts: int = 1,
        force: bool = False,
        task_status: TaskStatus = TaskStatus.PENDING,
        check_count: int = 0,
    ) -> Job:
        ops = operations or [TaskType.NFCE_EXPORT, TaskType.NFE_ISSUED_EXPORT, TaskType.NFE_RECEIVED_EXPORT]
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {
            "id": job_id,
            "client_id": client.id,
            "competence": competence,
            "start_date": date(2026, 8, 1),
            "end_date": date(2026, 8, 31),
            "operations": ops,
            "force_reschedule": force,
            "status": status,
            "attempts": attempts,
            "max_attempts": 3,
            "check_count": check_count,
            "cancel_requested": False,
            "manual_action_confirmed_at": None,
            "provider": "SIAT",
        }
        for op in ops:
            doc = TASK_DOCUMENT.get(op)
            tid = str(uuid.uuid4())
            self.tasks[tid] = {
                "id": tid,
                "job_id": job_id,
                "client_id": client.id,
                "task_type": op,
                "status": task_status,
                "competence": competence,
                "document_type": doc,
                "operation_type": "EXPORT" if doc else str(op).split("_")[0],  # EFD | MALHA
                "dedup_key": build_dedup_key(client.id, competence, doc) if doc else None,
                "superseded": False,
                "retry_count": 0,
                "result": {},
                "created": len(self.tasks),
            }
        return Job.model_validate(self.jobs[job_id])

    def job(self, job_id: str) -> dict[str, Any]:
        return self.jobs[job_id]

    def tasks_of(self, job_id: str) -> list[dict[str, Any]]:
        return [t for t in self.tasks.values() if t["job_id"] == job_id]

    # -- JobRepository ----------------------------------------------------------
    async def claim_next_job(self, worker_id: str) -> Job | None:
        for j in self.jobs.values():
            if j["status"] == "queued" and not j.get("locked_by"):
                j.update(status="starting", locked_by=worker_id, attempts=j["attempts"] + 1)
                return Job.model_validate(j)
        return None

    async def claim_next_collection(self, worker_id: str) -> Job | None:
        for j in self.jobs.values():
            if j["status"] == "waiting_sefaz" and not j.get("locked_by"):
                j.update(status="checking_processing", locked_by=worker_id, check_count=j["check_count"] + 1)
                return Job.model_validate(j)
        return None

    async def get_job(self, job_id: str) -> Job | None:
        return Job.model_validate(self.jobs[job_id]) if job_id in self.jobs else None

    async def get_client(self, client_id: str) -> Client | None:
        return self.clients.get(client_id)

    async def get_active_certificate(self, client_id: str) -> Certificate | None:
        return self.certificates.get(client_id)

    async def list_tasks(self, job_id: str) -> list[Task]:
        rows = sorted(self.tasks_of(job_id), key=lambda t: t["created"])
        return [Task.model_validate(t) for t in rows]

    async def update_job(self, job_id: str, **fields: Any) -> None:
        self.jobs[job_id].update(fields)
        self.job_updates.append((job_id, dict(fields)))

    async def update_task(self, task_id: str, **fields: Any) -> None:
        if "status" in fields:
            fields["status"] = TaskStatus(fields["status"])
        self.tasks[task_id].update(fields)

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
        tid = str(uuid.uuid4())
        self.tasks[tid] = {
            "id": tid,
            "job_id": job_id,
            "client_id": client_id,
            "task_type": task_type,
            "status": status,
            "competence": competence,
            "document_type": document_type,
            "superseded": False,
            "retry_count": 0,
            "result": result or {},
            "created": len(self.tasks),
        }
        return Task.model_validate(self.tasks[tid])

    async def find_active_export(self, dedup_key: str, exclude_task_id: str | None = None) -> Task | None:
        for t in self.tasks.values():
            if (
                t.get("dedup_key") == dedup_key
                and t["id"] != exclude_task_id
                and not t["superseded"]
                and TaskStatus(t["status"]) in ACTIVE_TASK_STATUSES
            ):
                return Task.model_validate(t)
        return None

    async def add_log(self, **kw: Any) -> None:
        self.logs.append(kw)

    async def insert_download(self, **fields: Any) -> dict[str, Any]:
        self.downloads.append(fields)
        return fields

    async def upsert_efd_declaration(self, **fields: Any) -> None:
        self.efd = [d for d in getattr(self, "efd", []) if d["epe_number"] != fields["epe_number"]]
        self.efd.append(fields)

    async def upsert_malha_check(self, **fields: Any) -> None:
        if not hasattr(self, "malhas"):
            self.malhas = {}
        self.malhas[fields["client_id"]] = fields

    async def get_download(self, download_id: str) -> dict[str, Any] | None:
        return None

    async def list_downloads_without_drive_id(self, limit: int) -> list[dict[str, Any]]:
        return [d for d in self.downloads if not d.get("drive_client_folder_id")][:limit]

    async def list_downloads_without_note_count(self, limit: int) -> list[dict[str, Any]]:
        return [d for d in self.downloads if d.get("note_count") is None][:limit]

    async def set_download_note_count(self, download_id: str, count: int) -> None:
        for d in self.downloads:
            if d.get("id") == download_id:
                d["note_count"] = count

    async def list_client_names(self) -> dict[str, str | None]:
        return {c.client_code: c.trade_name or c.legal_name for c in self.clients.values()}

    async def rename_download(self, old_filename: str, new_filename: str, new_filepath: str, checksum: str) -> int:
        hits = [d for d in self.downloads if d.get("filename") == old_filename and d.get("checksum") == checksum]
        for d in hits:
            d.update(filename=new_filename, filepath=new_filepath)
        return len(hits)

    async def clear_download_drive_ids(self) -> int:
        linked = [d for d in self.downloads if d.get("drive_file_id")]
        for d in linked:
            d.update(drive_file_id=None, drive_client_folder_id=None, drive_month_folder_id=None)
        return len(linked)

    async def set_download_drive_ids(
        self, download_id: str, file_id: str, client_folder_id: str, month_folder_id: str
    ) -> None:
        for d in self.downloads:
            if d.get("id") == download_id:
                d.update(drive_file_id=file_id, drive_client_folder_id=client_folder_id, drive_month_folder_id=month_folder_id)

    async def hand_over_job(self, job_id: str, worker_id: str, *, collect: bool = False) -> dict[str, Any]:
        import re

        self.handovers.append((job_id, worker_id, collect))
        job = self.jobs[job_id]
        host = re.sub(r"-[0-9]+$", "", worker_id)
        skip = list(job.get("skip_hosts") or [])
        if host not in skip:
            skip.append(host)
        job["skip_hosts"] = skip
        others = [h for h in self.other_hosts if h not in skip]
        if not others:
            return {"handed_over": False, "tried": skip, "waiting_for": []}
        if collect:
            job.update(status="waiting_sefaz", locked_by=None, check_count=max(job["check_count"] - 1, 0))
        else:
            job.update(status="queued", locked_by=None, attempts=max(job.get("attempts", 1) - 1, 0))
        return {"handed_over": True, "tried": skip, "waiting_for": others}

    async def release_lock(self, job_id: str, worker_id: str) -> None:
        if self.jobs[job_id].get("locked_by") == worker_id:
            self.jobs[job_id]["locked_by"] = None
        self.released.append(job_id)

    async def is_cancel_requested(self, job_id: str) -> bool:
        return bool(self.jobs[job_id].get("cancel_requested"))

    async def get_manual_confirmation(self, job_id: str) -> datetime | None:
        return self.jobs[job_id].get("manual_action_confirmed_at")

    async def heartbeat(self, worker_id: str, kind: str, status: str, current_job_id: str | None, meta: dict) -> None:
        self.heartbeats.append({"worker_id": worker_id, "status": status})

    async def release_stale_locks(self, minutes: int) -> int:
        return 0

    # -- recuperação -----------------------------------------------------------
    async def list_locked_jobs(self) -> list[dict[str, Any]]:
        return [dict(j) for j in self.jobs.values() if j.get("locked_by")]

    async def list_heartbeats(self) -> dict[str, dict[str, Any]]:
        return dict(self.heartbeat_rows)

    async def update_job_if_locked_by(self, job_id: str, owner: str, **fields: Any) -> bool:
        if self.jobs[job_id].get("locked_by") != owner:
            return False
        await self.update_job(job_id, **fields)
        return True

    # -- retenção -------------------------------------------------------------
    async def list_downloads_before(self, cutoff: datetime) -> list[dict[str, Any]]:
        return [d for d in self.downloads if d.get("downloaded_at") and d["downloaded_at"] < cutoff]

    async def delete_rows(self, table: str, ids: list[str]) -> int:
        assert table == "downloads"
        before = len(self.downloads)
        self.downloads = [d for d in self.downloads if d.get("id") not in ids]
        return before - len(self.downloads)

    async def delete_jobs_finished_before(self, cutoff: datetime, statuses: list[str]) -> int:
        old = [
            jid
            for jid, j in self.jobs.items()
            if j["status"] in statuses and (j.get("finished_at") or j.get("created_at") or cutoff) < cutoff
        ]
        for jid in old:
            del self.jobs[jid]
            self.tasks = {tid: t for tid, t in self.tasks.items() if t["job_id"] != jid}
            self.logs = [entry for entry in self.logs if entry.get("job_id") != jid]
        return len(old)

    async def delete_older_than(
        self, table: str, column: str, cutoff: datetime, *, eq: dict | None = None, in_: dict | None = None
    ) -> int:
        self.retention_calls.append((table, column, cutoff, eq, in_))
        return 0

    async def refresh_certificate_statuses(self) -> int:
        return 0

    async def generate_certificate_expiry_notifications(self) -> int:
        return 0

    async def get_setting(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)

    async def ping(self) -> bool:
        return True

    def log_messages(self, level: LogLevel | None = None) -> list[str]:
        return [l["message"] for l in self.logs if level is None or l["level"] == level]


class FakeProvider(AutomationProvider):
    """Simula o portal. Comportamentos configuráveis por atributos."""

    name = "SIAT"

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.login_error: Exception | None = None
        self.select_error: Exception | None = None
        self.schedule_error: dict[TaskType, Exception] = {}
        self.statuses: dict[DocumentType, ExportStatus] = {}
        self.download_dir = None
        self.download_errors: dict[DocumentType, Exception] = {}
        self.on_schedule: Callable[[Task], None] | None = None
        self.efd_messages: list = []  # DteMessage devolvidas pelo "DT-e"
        self.efd_error: Exception | None = None
        self.malha_result = None  # MalhaResult devolvido pela "Consulta de Malhas"
        self.malha_error: Exception | None = None

    @asynccontextmanager
    async def open_session(self, ctx: AutomationContext) -> AsyncIterator[AutomationContext]:
        self.calls.append("open_session")
        from app.jobs.state_machine import JobStatus

        await ctx.reporter.step(JobStatus.OPENING_BROWSER)
        try:
            yield ctx
        finally:  # como o BrowserSession real: fecha mesmo com erro/cancelamento
            self.calls.append("close_session")

    async def login(self, ctx: AutomationContext) -> None:
        from app.jobs.state_machine import JobStatus

        self.calls.append("login")
        await ctx.reporter.step(JobStatus.OPENING_SIAT)
        if self.login_error:
            raise self.login_error
        await ctx.reporter.step(JobStatus.AUTHENTICATING)

    async def select_company(self, ctx: AutomationContext) -> None:
        from app.jobs.state_machine import JobStatus

        self.calls.append("select_company")
        await ctx.reporter.step(JobStatus.SELECTING_TAXPAYER)
        if self.select_error:
            raise self.select_error

    async def verify_company(self, ctx: AutomationContext) -> None:
        self.calls.append("verify_company")

    async def schedule(self, ctx: AutomationContext, task: Task) -> ExportRequestResult:
        self.calls.append(f"schedule:{task.task_type}")
        if self.on_schedule:
            self.on_schedule(task)
        err = self.schedule_error.get(task.task_type)
        if err:
            raise err
        return ExportRequestResult(
            document_type=task.document_type,  # type: ignore[arg-type]
            external_request_id=None if ctx.dry_run else f"PROT-{task.task_type.value}",
            requested_at=now(),
            dry_run=ctx.dry_run,
        )

    async def check_status(self, ctx: AutomationContext, tasks: list[Task]) -> list[ExportStatusResult]:
        self.calls.append("check_status")
        return [
            ExportStatusResult(
                document_type=t.document_type,  # type: ignore[arg-type]
                external_request_id=t.external_request_id,
                status=self.statuses.get(t.document_type, ExportStatus.PROCESSING),  # type: ignore[arg-type]
                row_index=i,
            )
            for i, t in enumerate(tasks)
        ]

    async def download(self, ctx: AutomationContext, task: Task, status: ExportStatusResult) -> DownloadedFile:
        self.calls.append(f"download:{task.document_type}")
        if task.document_type in self.download_errors:
            raise self.download_errors[task.document_type]
        tmp = ctx.settings.downloads_dir.parent / f"tmp_{task.id}.zip"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(f"conteudo {task.document_type}".encode())
        return ctx.organizer.store(tmp, ctx.client.client_code, ctx.job.competence, task.document_type)  # type: ignore[arg-type]


async def _read_efd_messages(self, ctx: AutomationContext, competence: str) -> list:
    self.calls.append(f"read_efd:{competence}")
    if self.efd_error:
        raise self.efd_error
    return list(self.efd_messages)


FakeProvider.read_efd_messages = _read_efd_messages  # type: ignore[method-assign]


async def _read_malhas(self, ctx: AutomationContext):  # noqa: ANN202
    from app.automation.siat.siat_malhas import MalhaResult

    self.calls.append("read_malhas")
    if self.malha_error:
        raise self.malha_error
    return self.malha_result or MalhaResult(state_registration=ctx.client.state_registration or "", legal_name="")


FakeProvider.read_malhas = _read_malhas  # type: ignore[method-assign]


def registry_with(provider: FakeProvider) -> ProviderRegistry:
    reg = ProviderRegistry()
    reg.register("SIAT", lambda: provider)
    return reg
