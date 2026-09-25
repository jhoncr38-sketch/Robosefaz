"""Modelos de domínio (espelham as tabelas do Supabase)."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class TaskType(StrEnum):
    NFCE_EXPORT = "NFCE_EXPORT"
    NFE_ISSUED_EXPORT = "NFE_ISSUED_EXPORT"
    NFE_RECEIVED_EXPORT = "NFE_RECEIVED_EXPORT"
    CHECK_PROCESSING = "CHECK_PROCESSING"
    DOWNLOAD = "DOWNLOAD"


EXPORT_TASK_TYPES: tuple[TaskType, ...] = (
    TaskType.NFCE_EXPORT,
    TaskType.NFE_ISSUED_EXPORT,
    TaskType.NFE_RECEIVED_EXPORT,
)


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SCHEDULED = "scheduled"
    PROCESSED = "processed"
    DOWNLOADED = "downloaded"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"
    DRY_RUN = "dry_run"


ACTIVE_TASK_STATUSES = frozenset(
    {
        TaskStatus.PENDING,
        TaskStatus.RUNNING,
        TaskStatus.SCHEDULED,
        TaskStatus.PROCESSED,
        TaskStatus.DOWNLOADED,
        TaskStatus.COMPLETED,
    }
)


class DocumentType(StrEnum):
    NFCE = "NFCE"
    NFE_EMITIDAS = "NFE_EMITIDAS"
    NFE_RECEBIDAS = "NFE_RECEBIDAS"


TASK_DOCUMENT: dict[TaskType, DocumentType] = {
    TaskType.NFCE_EXPORT: DocumentType.NFCE,
    TaskType.NFE_ISSUED_EXPORT: DocumentType.NFE_EMITIDAS,
    TaskType.NFE_RECEIVED_EXPORT: DocumentType.NFE_RECEBIDAS,
}


class LogLevel(StrEnum):
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", use_enum_values=False)


class Client(_Base):
    id: str
    client_code: str
    legal_name: str
    trade_name: str | None = None
    cnpj: str
    state_registration: str | None = None
    uf: str = "PI"
    active: bool = True
    uses_nfce: bool = True
    uses_nfe_issued: bool = True
    uses_nfe_received: bool = True
    provider: str = "SIAT"

    @property
    def display_name(self) -> str:
        return self.trade_name or self.legal_name


class Certificate(_Base):
    id: str
    client_id: str
    type: str = "A1"
    subject_name: str
    issuer: str | None = None
    serial_number: str | None = None
    thumbprint: str | None = None
    valid_from: datetime | None = None
    valid_until: datetime
    browser_profile: str | None = None
    status: str = "valid"
    active: bool = True
    requires_manual_selection: bool = False
    has_secret: bool = False


class Job(_Base):
    id: str
    client_id: str
    created_by: str | None = None
    provider: str = "SIAT"
    competence: str
    start_date: date
    end_date: date
    operations: list[TaskType] = Field(default_factory=list)
    force_reschedule: bool = False
    status: str = "queued"
    current_step: str | None = None
    progress: int = 0
    attempts: int = 0
    max_attempts: int = 3
    check_count: int = 0
    cancel_requested: bool = False
    locked_by: str | None = None
    manual_action_requested_at: datetime | None = None
    manual_action_confirmed_at: datetime | None = None
    started_at: datetime | None = None


class Task(_Base):
    id: str
    job_id: str
    client_id: str
    task_type: TaskType
    status: TaskStatus = TaskStatus.PENDING
    competence: str
    document_type: DocumentType | None = None
    operation_type: str | None = None
    dedup_key: str | None = None
    superseded: bool = False
    external_request_id: str | None = None
    requested_at: datetime | None = None
    retry_count: int = 0
    result: dict[str, Any] = Field(default_factory=dict)

    @property
    def is_export(self) -> bool:
        return self.task_type in EXPORT_TASK_TYPES


class ExportRequestResult(_Base):
    """Resultado de um agendamento de exportação no portal."""

    document_type: DocumentType
    external_request_id: str | None = None
    requested_at: datetime
    dry_run: bool = False
    raw_message: str | None = None


class ExportStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    PROCESSED = "processed"
    ERROR = "error"
    NOT_FOUND = "not_found"


class ExportStatusResult(_Base):
    document_type: DocumentType
    external_request_id: str | None = None
    status: ExportStatus
    raw_status: str | None = None
    row_index: int | None = None


class DownloadedFile(_Base):
    document_type: DocumentType
    filename: str
    filepath: str
    size: int
    checksum: str
