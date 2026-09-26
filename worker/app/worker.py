"""Processo do worker: `python -m app.worker [--mode all|scheduler|collector]`.

- Scheduler (Robô 1): consome jobs `queued` e agenda exportações.
- Collector (Robô 2): consome jobs `waiting_sefaz` e baixa os arquivos.
- Manutenção: libera locks órfãos, atualiza status de certificados e gera alertas.

Um semáforo global limita navegadores simultâneos a MAX_PARALLEL_JOBS (padrão 1).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import socket
import sys
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable

from app.automation.registry import default_registry
from app.config import Settings, get_settings
from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer
from app.jobs.base_runner import RunnerDeps
from app.jobs.collector_runner import CollectorRunner
from app.jobs.recovery import recover_orphaned_jobs
from app.jobs.repository import JobRepository, SupabaseJobRepository
from app.jobs.retention import RetentionService
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
        self.retention = RetentionService(repo, settings)
        self._next_retention_at: float | None = None

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
                await self.repo.refresh_certificate_statuses()
                await self.repo.generate_certificate_expiry_notifications()
            except Exception:
                log.exception("Falha na rotina de manutenção")
            now = time.monotonic()
            if self._next_retention_at is None or now >= self._next_retention_at:
                self._next_retention_at = now + self.settings.retention_interval_hours * 3600
                try:
                    await self.retention.run()
                except Exception:
                    log.exception("Falha na limpeza automática")
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

    async def _recovery(self) -> None:
        """A cada minuto: assume jobs de robôs que pararam de dar sinal (PC desligado etc.)."""
        await self._sleep(20)  # deixa o próprio heartbeat ser gravado primeiro
        while not self.stop_event.is_set():
            try:
                await recover_orphaned_jobs(
                    self.repo,
                    self.worker_id,
                    dead_after_s=self.settings.worker_dead_after_seconds,
                    stale_minutes=self.settings.stale_lock_minutes,
                )
            except Exception:
                log.exception("Falha ao recuperar jobs de robôs desligados")
            await self._sleep(60)

    def _write_local_status(self, status: str) -> None:
        """Estado para o ícone da bandeja (storage/worker-status.json), sem depender da internet."""
        path = self.settings.status_file
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "worker_id": self.worker_id,
                        "pid": os.getpid(),
                        "status": status,
                        "dry_run": self.settings.automation_dry_run,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                ),
                encoding="utf-8",
            )
            os.replace(tmp, path)
        except OSError as exc:
            log.debug("Não foi possível gravar %s: %s", path, exc)

    async def _local_status(self) -> None:
        while not self.stop_event.is_set():
            busy = self.settings.max_parallel_jobs - self.browser_slots._value  # noqa: SLF001
            self._write_local_status("busy" if busy > 0 else "idle")
            await self._sleep(5)

    async def _watch_stop_flag(self) -> None:
        """parar-robo.bat cria o arquivo-sinal: encerra com calma (o job atual termina)."""
        flag = self.settings.stop_flag
        while not self.stop_event.is_set():
            if flag.exists():
                log.warning("Pedido de parada recebido (%s).", flag)
                self.stop()
                return
            await self._sleep(3)

    async def run(self) -> None:
        tasks: list[asyncio.Task] = [
            asyncio.create_task(self._heartbeat(), name="heartbeat"),
            asyncio.create_task(self._maintenance(), name="maintenance"),
            asyncio.create_task(self._watch_stop_flag(), name="stop-flag"),
            asyncio.create_task(self._local_status(), name="local-status"),
            asyncio.create_task(self._recovery(), name="recovery"),
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
        self._write_local_status("stopped")
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


def _clear_stale_chrome_policy(settings: Settings) -> None:
    """Remove regra de certificado que sobrou de um robô encerrado à força."""
    if settings.chrome_policy_mode != "per_job" or not settings.chrome_policy_allow_write:
        return
    from app.certificates.chrome_policy import ChromeCertificatePolicyService, url_pattern

    try:
        service = ChromeCertificatePolicyService(
            channel=settings.browser_channel,
            allow_write=True,
            state_file=settings.profiles_dir / "_chrome_policy_state.json",
        )
        removed = service.remove_pattern(url_pattern(settings.chrome_policy_pattern), confirm=True)
        if removed:
            log.warning("Regra antiga do Chrome removida (sobra de um robô interrompido): %s", removed)
    except Exception as exc:  # noqa: BLE001 - sem permissão: o job tenta de novo e cai no modo manual
        log.warning("Não foi possível limpar regras antigas do Chrome: %s", exc)


async def _sync_client_folders(settings: Settings, client) -> None:  # noqa: ANN001
    """Pastas de notas com o nome da empresa (renomeia 'CLI000001' e nomes antigos)."""
    try:
        rows = (await client.table("clients").select("client_code, legal_name, trade_name").execute()).data or []
        organizer = DownloadOrganizer(settings.downloads_dir)
        for r in rows:
            organizer.sync_client_dir(r["client_code"], r.get("trade_name") or r.get("legal_name"))
    except Exception as exc:  # noqa: BLE001 - pasta indisponível/sem internet: tenta no próximo início
        log.warning("Não foi possível organizar as pastas dos clientes: %s", exc)


async def amain(mode: str) -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_file)
    settings.stop_flag.unlink(missing_ok=True)  # sinal antigo não derruba o worker novo
    try:
        DownloadOrganizer(settings.downloads_dir).check_available()
        log.info("Downloads serão salvos em %s", settings.downloads_dir)
    except DownloadFolderUnavailable as exc:
        log.warning("Pasta de downloads indisponível agora (%s); o collector tentará de novo mais tarde.", exc)
    _clear_stale_chrome_policy(settings)
    client = await get_supabase(settings)
    await _sync_client_folders(settings, client)
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
