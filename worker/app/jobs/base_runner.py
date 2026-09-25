"""Infraestrutura comum aos robôs Scheduler e Collector."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from app.automation.base import AutomationContext
from app.automation.registry import ProviderRegistry
from app.browser.screenshots import capture_error_screenshot
from app.certificates.certificate_manager import CertificateManager
from app.config import Settings
from app.downloads.organizer import DownloadOrganizer
from app.jobs.errors import AutomationError, ErrorCode, error_code_of
from app.jobs.models import Certificate, Client, Job
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.retry import RetryPolicy
from app.logs.job_logger import JobLogger


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class RunnerDeps:
    repo: JobRepository
    registry: ProviderRegistry
    settings: Settings
    certificate_manager: CertificateManager
    organizer: DownloadOrganizer
    worker_id: str
    retry_policy: RetryPolicy

    @classmethod
    def build(
        cls,
        repo: JobRepository,
        registry: ProviderRegistry,
        settings: Settings,
        worker_id: str,
        *,
        certificate_manager: CertificateManager | None = None,
        organizer: DownloadOrganizer | None = None,
    ) -> "RunnerDeps":
        return cls(
            repo=repo,
            registry=registry,
            settings=settings,
            certificate_manager=certificate_manager or CertificateManager(),
            organizer=organizer or DownloadOrganizer(settings.downloads_dir),
            worker_id=worker_id,
            retry_policy=RetryPolicy(delays=tuple(settings.retry_delay_list), max_retries=settings.max_attempts),
        )


class BaseRunner:
    phase = "schedule"

    def __init__(self, deps: RunnerDeps) -> None:
        self.deps = deps
        self.repo = deps.repo
        self.settings = deps.settings

    async def load_client_and_certificate(self, job: Job) -> tuple[Client, Certificate | None]:
        client = await self.repo.get_client(job.client_id)
        if client is None:
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Cliente do job não encontrado.")
        if not client.active:
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Cliente inativo.")
        certificate = await self.repo.get_active_certificate(client.id)
        return client, certificate

    def build_context(
        self, job: Job, client: Client, certificate: Certificate | None, reporter: JobReporter, logger: JobLogger
    ) -> AutomationContext:
        return AutomationContext(
            job=job,
            client=client,
            certificate=certificate,
            settings=self.settings,
            reporter=reporter,
            logger=logger,
            organizer=self.deps.organizer,
        )

    async def error_screenshot(self, ctx: AutomationContext | None, job: Job, logger: JobLogger) -> str | None:
        # o provider captura antes de fechar o navegador; senão tenta agora
        path = ctx.state.get("error_screenshot") if ctx is not None else None
        if not path:
            page = ctx.page if ctx is not None else None
            path = await capture_error_screenshot(page, self.settings.errors_dir, job.id)
        if path:
            await logger.info(f"Screenshot do erro salvo em {path}", step="error", metadata={"screenshot": path})
        return path

    @staticmethod
    def describe(error: BaseException) -> tuple[ErrorCode, str]:
        if isinstance(error, AutomationError):
            return error.code, error.message
        return error_code_of(error), f"{type(error).__name__}: {error}"
