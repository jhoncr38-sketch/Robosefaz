"""Reporter de etapas: atualiza o job no banco (Realtime -> painel) a cada passo."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Awaitable, Callable

from app.browser.screenshots import capture_step_screenshot
from app.jobs.errors import JobCancelled, ManualActionRequired
from app.jobs.state_machine import JobStateMachine, JobStatus, label_for

if TYPE_CHECKING:
    from playwright.async_api import Page

    from app.config import Settings
    from app.jobs.models import Job
    from app.jobs.repository import JobRepository
    from app.logs.job_logger import JobLogger


class JobReporter:
    def __init__(
        self,
        repo: "JobRepository",
        job: "Job",
        settings: "Settings",
        logger: "JobLogger",
        *,
        phase: str,
        initial: JobStatus,
        page_getter: Callable[[], "Page | None"] = lambda: None,
        poll_interval: float = 2.0,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.repo = repo
        self.job = job
        self.settings = settings
        self.logger = logger
        self.machine = JobStateMachine(initial, phase=phase)
        self.page_getter = page_getter
        self.poll_interval = poll_interval
        self._sleep = sleep

    @property
    def state(self) -> JobStatus:
        return self.machine.state

    async def step(self, status: JobStatus, message: str | None = None) -> None:
        await self.check_cancel()
        self.machine.transition(status)
        text = message or label_for(status)
        await self.repo.update_job(
            self.job.id,
            status=status.value,
            current_step=status.value,
            progress=self.machine.progress,
            last_message=text,
            locked_at=datetime.now(timezone.utc),  # heartbeat do lock
        )
        await self.logger.info(text, step=status.value)
        if self.settings.automation_screenshots:
            await self.screenshot(status.value)

    async def set_final(self, status: JobStatus, **fields) -> None:  # noqa: ANN003
        """Transição para estado de saída (waiting_sefaz, completed, failed...)."""
        self.machine.transition(status)
        payload = {"status": status.value, "current_step": status.value, "progress": self.machine.progress}
        payload.update(fields)
        await self.repo.update_job(self.job.id, **payload)

    async def check_cancel(self) -> None:
        if await self.repo.is_cancel_requested(self.job.id):
            raise JobCancelled()

    async def screenshot(self, step: str) -> None:
        if not self.settings.automation_screenshots:
            return
        path = await capture_step_screenshot(self.page_getter(), self.settings.screenshots_dir, self.job.id, step)
        if path:
            await self.logger.debug(f"Screenshot da etapa: {path}", step=step, metadata={"screenshot": path})

    async def wait_for_user_confirmation(
        self,
        message: str,
        *,
        status: JobStatus = JobStatus.MANUAL_ACTION_REQUIRED,
        resolved: Callable[[], Awaitable[bool]] | None = None,
        timeout_ms: int | None = None,
    ) -> None:
        """Pausa a automação até o usuário confirmar no painel ou a condição se resolver.

        O navegador permanece aberto na máquina do worker para o usuário agir.
        """
        previous = self.machine.state
        requested_at = datetime.now(timezone.utc)
        self.machine.transition(status)
        await self.repo.update_job(
            self.job.id,
            status=status.value,
            current_step=status.value,
            progress=self.machine.progress,
            last_message=message,
            manual_action_message=message,
            manual_action_requested_at=requested_at,
            manual_action_confirmed_at=None,
            locked_at=requested_at,
        )
        await self.logger.warning(f"A automação está aguardando sua intervenção: {message}", step=status.value)

        loop = asyncio.get_running_loop()
        timeout = (timeout_ms or self.settings.manual_action_timeout) / 1000
        deadline = loop.time() + timeout
        last_heartbeat = loop.time()
        confirmed_by_user = False
        while True:
            await self.check_cancel()
            if resolved is not None:
                try:
                    if await resolved():
                        break
                except Exception:  # condição best effort (página pode estar navegando)
                    pass
            confirmed = await self.repo.get_manual_confirmation(self.job.id)
            if confirmed is not None and confirmed >= requested_at:
                confirmed_by_user = True
                break
            if loop.time() >= deadline:
                raise ManualActionRequired(f"Tempo esgotado aguardando intervenção: {message}")
            if loop.time() - last_heartbeat > 60:
                await self.repo.update_job(self.job.id, locked_at=datetime.now(timezone.utc))
                last_heartbeat = loop.time()
            await self._sleep(self.poll_interval)

        await self.logger.info(
            "Intervenção confirmada pelo usuário." if confirmed_by_user else "Intervenção concluída; retomando.",
            step=status.value,
        )
        self.machine.transition(previous)
        await self.repo.update_job(
            self.job.id,
            status=previous.value,
            current_step=previous.value,
            progress=self.machine.progress,
            manual_action_message=None,
            last_message="Retomando automação",
        )
