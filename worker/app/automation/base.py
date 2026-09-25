"""Contrato genérico para portais fiscais (SIAT, e-CAC, prefeituras...)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Protocol

from app.jobs.models import (
    Certificate,
    Client,
    DocumentType,
    DownloadedFile,
    ExportRequestResult,
    ExportStatusResult,
    Job,
    Task,
    TaskType,
)
from app.jobs.state_machine import JobStatus

if TYPE_CHECKING:
    from playwright.async_api import Page

    from app.config import Settings
    from app.downloads.organizer import DownloadOrganizer
    from app.logs.job_logger import JobLogger


class StepReporter(Protocol):
    """Canal do provider com o runner (status, cancelamento, intervenção manual)."""

    async def step(self, status: JobStatus, message: str | None = None) -> None: ...

    async def check_cancel(self) -> None: ...

    async def wait_for_user_confirmation(
        self,
        message: str,
        *,
        status: JobStatus = JobStatus.MANUAL_ACTION_REQUIRED,
        resolved: Callable[[], Awaitable[bool]] | None = None,
        timeout_ms: int | None = None,
    ) -> None: ...

    async def screenshot(self, step: str) -> None: ...


@dataclass(slots=True)
class AutomationContext:
    job: Job
    client: Client
    certificate: Certificate | None
    settings: "Settings"
    reporter: StepReporter
    logger: "JobLogger"
    organizer: "DownloadOrganizer"
    page: "Page | None" = None
    state: dict[str, Any] = field(default_factory=dict)

    @property
    def start_date(self) -> date:
        return self.job.start_date

    @property
    def end_date(self) -> date:
        return self.job.end_date

    @property
    def dry_run(self) -> bool:
        return self.settings.automation_dry_run


class AutomationProvider(ABC):
    """Interface que todo portal deve implementar."""

    name: str = "BASE"
    supported_tasks: frozenset[TaskType] = frozenset()

    @abstractmethod
    def open_session(self, ctx: AutomationContext) -> AbstractAsyncContextManager[AutomationContext]:
        """Abre o navegador com o perfil exclusivo do cliente e preenche ctx.page."""

    @abstractmethod
    async def login(self, ctx: AutomationContext) -> None:
        """Autentica no portal (certificado digital)."""

    @abstractmethod
    async def select_company(self, ctx: AutomationContext) -> None:
        """Seleciona o contribuinte e valida que corresponde ao cliente do job."""

    @abstractmethod
    async def verify_company(self, ctx: AutomationContext) -> None:
        """Guarda de segurança: confirma o contribuinte aberto antes de qualquer ação."""

    @abstractmethod
    async def schedule(self, ctx: AutomationContext, task: Task) -> ExportRequestResult:
        """Agenda a exportação correspondente à tarefa."""

    @abstractmethod
    async def check_status(self, ctx: AutomationContext, tasks: list[Task]) -> list[ExportStatusResult]:
        """Consulta o status dos agendamentos."""

    @abstractmethod
    async def download(
        self, ctx: AutomationContext, task: Task, status: ExportStatusResult
    ) -> DownloadedFile:
        """Baixa o arquivo processado e devolve os dados do arquivo organizado."""

    def document_for(self, task: Task) -> DocumentType:
        if task.document_type is None:
            raise ValueError(f"Tarefa {task.id} sem document_type")
        return task.document_type
