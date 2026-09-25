"""Processo do worker: `python -m app.worker [--mode all|scheduler|collector]`.

- Scheduler (Robô 1): consome jobs `queued` e agenda exportações.
- Collector (Robô 2): consome jobs `waiting_sefaz` e baixa os arquivos.
- Manutenção: libera locks órfãos, atualiza status de certificados e gera alertas.

Um semáforo global limita navegadores simultâneos a MAX_PARALLEL_JOBS (padrão 1).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import socket
import sys
from typing import Awaitable, Callable

from app.automation.registry import default_registry
from app.config import Settings, get_settings
from app.jobs.base_runner import RunnerDeps
from app.jobs.collector_runner import CollectorRunner
from app.jobs.repository import JobRepository, SupabaseJobRepository
from app.jobs.scheduler_runner import SchedulerRunner
from app.logs.job_logger import configure_logging
from app.services.supabase_client import get_supabase

log = logging.getLogger("worker")


def make_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


class Worker:
    def __init__(self, repo: JobRepository, settings: Settings, *, mode: str = "all", worker_id: str | None = None) -> None:
        self.repo = repo
        self.settings = settings
        self.mode = mode
        self.worker_id = worker_id or make_worker_id()
        self.stop_event = asyncio.Event()
        self.browser_slots = asyncio.Semaphore(settings.max_parallel_jobs)
        self.current_jobs: set[str] = set()
        deps = RunnerDeps.build(repo, default_registry(), settings, self.worker_id)
        self.scheduler = SchedulerRunner(deps)
        self.collector = CollectorRunner(deps)

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.stop_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _consume(self, name: str, run_once: Callable[[], Awaitable[bool]], idle: float) -> None:
        log.info("%s iniciado (worker %s)", name, self.worker_id)
        while not self.stop_event.is_set():
            worked = False
            try:
                async with self.browser_slots:
                    if self.stop_event.is_set():
                        break
                    worked = await run_once()
            except Exception:
                log.exception("%s: erro inesperado no loop", name)
            if not worked:
                await self._sleep(idle)
        log.info("%s finalizado", name)

    async def _maintenance(self) -> None:
        while not self.stop_event.is_set():
            try:
                released = await self.repo.release_stale_locks(self.settings.stale_lock_minutes)
                if released:
                    log.warning("%s lock(s) órfão(s) liberado(s)", released)
                await self.repo.refresh_certificate_statuses()
                await self.repo.generate_certificate_expiry_notifications()
            except Exception:
                log.exception("Falha na rotina de manutenção")
            await self._sleep(300)

    async def _heartbeat(self) -> None:
        while not self.stop_event.is_set():
            try:
                busy = self.settings.max_parallel_jobs - self.browser_slots._value  # noqa: SLF001
                await self.repo.heartbeat(
                    self.worker_id,
                    self.mode,
                    "busy" if busy > 0 else "idle",
                    None,
                    {
                        "max_parallel_jobs": self.settings.max_parallel_jobs,
                        "busy_slots": busy,
                        "dry_run": self.settings.automation_dry_run,
                        "headless": self.settings.automation_headless,
                        "browser_channel": self.settings.browser_channel,
                        "platform": sys.platform,
                    },
                )
            except Exception as exc:
                log.warning("Heartbeat falhou: %s", exc)
            await self._sleep(30)

    async def run(self) -> None:
        tasks: list[asyncio.Task] = [
            asyncio.create_task(self._heartbeat(), name="heartbeat"),
            asyncio.create_task(self._maintenance(), name="maintenance"),
        ]
        if self.mode in ("all", "scheduler"):
            for i in range(self.settings.max_parallel_jobs):
                tasks.append(
                    asyncio.create_task(
                        self._consume(f"scheduler-{i + 1}", self.scheduler.run_once, self.settings.worker_poll_interval)
                    )
                )
        if self.mode in ("all", "collector"):
            tasks.append(
                asyncio.create_task(
                    self._consume("collector", self.collector.run_once, self.settings.collector_poll_interval)
                )
            )
        log.info(
            "Worker %s em execução (modo=%s, paralelismo=%s, dry_run=%s, headless=%s)",
            self.worker_id,
            self.mode,
            self.settings.max_parallel_jobs,
            self.settings.automation_dry_run,
            self.settings.automation_headless,
        )
        self._tasks = tasks
        await self.stop_event.wait()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await self.repo.heartbeat(self.worker_id, self.mode, "stopped", None, {})
        except Exception:
            pass

    def stop(self) -> None:
        if self.stop_event.is_set():
            # 2º Ctrl+C: interrompe já; os runners fecham o navegador e devolvem o job à fila
            log.warning("Interrompendo agora: fechando navegador e devolvendo o job atual para a fila...")
            for task in getattr(self, "_tasks", []):
                task.cancel()
            return
        log.warning(
            "Encerrando o worker: aguardando o job em andamento terminar. "
            "Aperte Ctrl+C de novo para interromper agora (o job volta para a fila)."
        )
        self.stop_event.set()


async def amain(mode: str) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    client = await get_supabase(settings)
    repo = SupabaseJobRepository(client)
    worker = Worker(repo, settings, mode=mode)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, worker.stop)
        except (NotImplementedError, RuntimeError):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(worker.stop))
    await worker.run()


def main() -> None:
    parser = argparse.ArgumentParser(description="Worker de automação SIAT")
    parser.add_argument("--mode", choices=["all", "scheduler", "collector"], default="all")
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    try:
        asyncio.run(amain(args.mode))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
