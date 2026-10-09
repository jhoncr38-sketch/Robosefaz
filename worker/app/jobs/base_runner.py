"""Infraestrutura comum aos robôs Scheduler e Collector."""

from __future__ import annotations

import re
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator
from datetime import datetime, timezone

from app.automation.base import AutomationContext
from app.automation.registry import ProviderRegistry
from app.browser.screenshots import capture_error_screenshot
from app.certificates.certificate_manager import CertificateManager
from app.config import Settings
from app.downloads.fallback import organizer_for
from app.downloads.organizer import DownloadOrganizer
from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode, error_code_of
from app.jobs.models import Certificate, Client, Job
from app.jobs.quick_check import QuickCheckGovernor
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.retry import RetryPolicy
from app.logs.job_logger import JobLogger


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Activity:
    """Jobs em processamento de verdade (não conta a consulta à fila a cada 5 s)."""

    def __init__(self) -> None:
        self.running = 0
        self.last_active = time.monotonic()
        self.jobs: set[str] = set()  # ids em processamento (a recuperação não mexe neles)

    @contextmanager
    def job(self, job_id: str | None = None) -> Iterator[None]:
        self.running += 1
        if job_id:
            self.jobs.add(job_id)
        try:
            yield
        finally:
            self.running -= 1
            self.jobs.discard(job_id or "")
            self.last_active = time.monotonic()

    @property
    def busy(self) -> bool:
        return self.running > 0

    def idle_for(self, now: float | None = None) -> float:
        """Segundos sem processar nenhum job (0 enquanto houver job em andamento)."""
        if self.running:
            return 0.0
        return (now if now is not None else time.monotonic()) - self.last_active


@dataclass(slots=True)
class RunnerDeps:
    repo: JobRepository
    registry: ProviderRegistry
    settings: Settings
    certificate_manager: CertificateManager
    organizer: DownloadOrganizer
    worker_id: str
    retry_policy: RetryPolicy
    activity: Activity = field(default_factory=Activity)
    # o robô está encerrando (parar-robo, atualização, Ctrl+C): esperas opcionais são puladas
    stopping: Callable[[], bool] = field(default=lambda: False)
    # pausa automática da conferência rápida (SEFAZ lenta): compartilhada pelos agendadores deste robô
    quick_check: QuickCheckGovernor = field(default_factory=QuickCheckGovernor)

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
            quick_check=QuickCheckGovernor(
                misses_to_pause=max(1, settings.quick_check_pause_after),
                pause_seconds=max(0, settings.quick_check_pause_minutes) * 60,
            ),
            repo=repo,
            registry=registry,
            settings=settings,
            certificate_manager=certificate_manager or CertificateManager(),
            organizer=organizer or organizer_for(settings),
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

    async def hand_over(self, job: Job, logger: JobLogger, exc: BaseException, *, collect: bool) -> bool:
        """Certificado do cliente não instalado NESTE computador: repassa o trabalho a outro PC do escritório.

        True = repassado (o trabalho voltou para a fila e este computador não o pega de novo).
        False = não há outro computador para tentar: a mensagem do erro passa a dizer quem tentou.
        """
        if not isinstance(exc, CertificateNotInstalledError):
            return False
        try:
            result = await self.repo.hand_over_job(job.id, self.deps.worker_id, collect=collect)
        except Exception as err:  # noqa: BLE001 - banco antigo/sem rede: segue como antes
            await logger.warning(f"Não foi possível repassar o trabalho a outro computador: {err}", step="starting")
            return False
        tried = ", ".join(result.get("tried") or [])
        if result.get("handed_over"):
            others = ", ".join(result.get("waiting_for") or [])
            await logger.warning(
                f"O certificado deste cliente não está instalado neste computador ({re.sub(r'-[0-9]+$', '', self.deps.worker_id)}); "
                f"trabalho repassado para: {others}.",
                step="starting",
            )
            return True
        if tried:
            exc.message = (
                f"Certificado não instalado em nenhum computador disponível (tentado em: {tried}). "
                "Instale o A1 do cliente em um deles e clique em Reprocessar."
            )
        return False

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
