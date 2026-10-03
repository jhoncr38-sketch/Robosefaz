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
from pathlib import Path
from typing import Awaitable, Callable

from app.automation.registry import default_registry
from app.browser.window import robot_windows
from app import __version__
from app.config import Settings, get_settings
from app.downloads.drive_ids import DriveIdLookup, drivefs_databases, link_drive_ids, probe_account, update_link_state
from app.downloads.fallback import FallbackOrganizer, notes_folder_kind, organizer_for
from app.downloads.folder_owner import load_office, save_office
from app.downloads.note_count import count_pending_notes
from app.downloads.organizer import DownloadFolderUnavailable
from app.utils.files import sha256_file
from app.jobs.base_runner import RunnerDeps
from app.jobs.collector_runner import CollectorRunner
from app.jobs.recovery import recover_orphaned_jobs
from app.jobs.repository import JobRepository, SupabaseJobRepository
from app.jobs.retention import RetentionService
from app.jobs.scheduler_runner import SchedulerRunner
from app.logs.job_logger import configure_logging
from app.services.supabase_client import get_supabase, reset_supabase_client

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
        deps = RunnerDeps.build(repo, default_registry(), settings, self.worker_id)
        self.activity = deps.activity
        self.organizer = deps.organizer
        self._drive_db: Path | None = None  # banco da conta do Google Drive da pasta das notas
        self._uncountable: set[str] = set()  # downloads cujo ZIP não deu para ler aqui
        self._warned_foreign: str | None = None  # dono de outro escritório já avisado no log
        self._note_count_failures = 0
        self.scheduler = SchedulerRunner(deps)
        self.collector = CollectorRunner(deps)
        self.retention = RetentionService(repo, settings)
        robot_windows.always_visible = settings.browser_window == "visible"
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

    async def _resolve_office(self) -> None:
        """Escritório deste computador: a pasta das notas precisa ser dele (ver folder_owner)."""
        if self.organizer.office is not None:
            return
        office = None
        try:
            office = await self.repo.device_org()
        except Exception as exc:  # noqa: BLE001 - sem internet: usa o guardado da última vez
            log.warning("Não foi possível saber o escritório deste computador agora: %s", exc)
        if office is not None and not office.name:
            cached = await asyncio.to_thread(load_office, self.settings.office_file)
            if cached is not None and cached.id == office.id:
                office = cached
        if office is not None:
            try:
                await asyncio.to_thread(save_office, self.settings.office_file, office)
            except OSError as exc:
                log.warning("Não foi possível guardar o escritório deste computador: %s", exc)
        else:
            office = await asyncio.to_thread(load_office, self.settings.office_file)
        self.organizer.office = office

    def _notes_folder_ready(self) -> bool:
        """Pasta das notas no ar e deste escritório; de outro escritório: avisa uma vez no log."""
        try:
            self.organizer.check_available()
        except DownloadFolderUnavailable:
            owner = self.organizer.foreign_owner
            if owner is not None and self._warned_foreign != owner.id:
                self._warned_foreign = owner.id
                log.error(
                    'A pasta das notas (%s) é do escritório "%s". Este computador não grava nem mexe nela: as '
                    'notas ficam neste computador (%s). Rode "Salvar notas no Google Drive" para criar a pasta '
                    "deste escritório.",
                    self.organizer.base_dir,
                    owner.name,
                    self.settings.local_downloads_dir,
                )
            return False
        self._warned_foreign = None
        return True

    async def _maintenance(self) -> None:
        while not self.stop_event.is_set():
            await self._resolve_office()
            ready = await asyncio.to_thread(self._notes_folder_ready)
            try:
                await self.repo.refresh_certificate_statuses()
                await self.repo.generate_certificate_expiry_notifications()
            except Exception:
                log.exception("Falha na rotina de manutenção")
            try:
                # notas no formato antigo (cliente/ano/mês), ex.: copiadas por outro computador
                await asyncio.to_thread(self.organizer.reorganize)
            except Exception:
                log.exception("Falha ao reorganizar a pasta das notas")
            try:
                # notas com o nome da empresa (formato da 1.2.26), aos poucos: 50 por rodada
                if ready:
                    await self._rename_notes()
            except Exception:
                log.exception("Falha ao renomear as notas com o nome da empresa")
            if isinstance(self.organizer, FallbackOrganizer):
                try:
                    # plano B: notas salvas na pasta local enquanto a pasta das notas estava fora do ar
                    await asyncio.to_thread(self.organizer.send_pending)
                except Exception:
                    log.exception("Falha ao enviar notas do plano B para a pasta das notas")
            if ready and notes_folder_kind(self.settings.downloads_dir) == "google_drive":
                try:
                    # botão "Baixar" do painel: código de cada nota no Google Drive (só na conta da pasta)
                    if await self._drive_account() is not None:
                        await link_drive_ids(self.repo, DriveIdLookup([self._drive_db]))
                except Exception:
                    log.exception("Falha ao ligar as notas ao Google Drive")
            if ready:
                await self._count_notes()
            now = time.monotonic()
            if self._next_retention_at is None or now >= self._next_retention_at:
                self._next_retention_at = now + self.settings.retention_interval_hours * 3600
                try:
                    await self.retention.run()
                except Exception:
                    log.exception("Falha na limpeza automática")
            await self._sleep(300)

    async def _rename_notes(self, limit: int = 50) -> int:
        """CLI000003_2026-08_NFCE_2.zip -> "LOJA X - NFC-e - 08-2026 - CLI000003 (2).zip" (só renomeia)."""
        if not self.organizer.base_dir.is_dir():
            return 0  # pasta das notas fora do ar (ex.: Google Drive desconectado): fica para depois
        names = await self.repo.list_client_names()
        renamed = await asyncio.to_thread(self.organizer.rename_notes, names, limit=limit)
        for old, new in renamed:
            checksum = await asyncio.to_thread(sha256_file, new)
            await self.repo.rename_download(old.name, new.name, str(new), checksum)
        if renamed:
            log.info("%s nota(s) renomeada(s) com o nome da empresa.", len(renamed))
        return len(renamed)

    async def _count_notes(self) -> None:
        """Quantidade de notas de cada ZIP (painel). Só lê; se falhar 3 vezes seguidas (ex.: banco
        ainda sem a coluna), para até o próximo início do robô, sem afetar o resto."""
        if self._note_count_failures >= 3:
            return
        try:
            await count_pending_notes(self.repo, self.organizer.base_dir, skip=self._uncountable)
            self._note_count_failures = 0
        except Exception:
            self._note_count_failures += 1
            log.warning("Falha ao contar as notas dos downloads (%s/3)", self._note_count_failures, exc_info=True)

    async def _drive_account(self) -> Path | None:
        """Conta do Google Drive da pasta das notas (1x por início do robô); troca de conta refaz os links."""
        if self._drive_db is not None:
            return self._drive_db
        folder = self.settings.downloads_dir
        db = await asyncio.to_thread(probe_account, folder, drivefs_databases())
        if db is None:
            return None  # Drive fechado: tenta na próxima rodada
        if update_link_state(self.settings.drive_link_file, folder, db.parent.name):
            cleared = await self.repo.clear_download_drive_ids()
            log.warning("A pasta ou a conta do Google Drive mudou: %s link(s) do botão Baixar serão refeitos.", cleared)
        self._drive_db = db
        return db

    async def _heartbeat(self) -> None:
        while not self.stop_event.is_set():
            try:
                busy = self.activity.running
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
                        "version": __version__,
                        "notes_folder": notes_folder_kind(self.settings.downloads_dir),
                        # pasta das notas de OUTRO escritório (o painel avisa; as notas ficam neste PC)
                        "notes_folder_owner": self.organizer.foreign_owner.name if self.organizer.foreign_owner else None,
                    },
                )
            except Exception as exc:
                log.warning("Heartbeat falhou: %s", exc)
            await self._sleep(30)

    async def _session(self) -> None:
        """Computador ativado: renova o acesso ao banco antes de expirar (1 h)."""
        from app.services.supabase_client import keep_session_alive

        while not self.stop_event.is_set():
            await self._sleep(20 * 60)
            try:
                await keep_session_alive(self.settings)
            except Exception:
                log.exception("Falha ao renovar o acesso do computador")

    async def _recovery(self) -> None:
        """A cada minuto: assume jobs de robôs que pararam de dar sinal (PC desligado etc.) e solta os
        que ficaram presos neste robô (ex.: a internet caiu na hora de gravar o fim do trabalho)."""
        await self._sleep(20)  # deixa o próprio heartbeat ser gravado primeiro
        while not self.stop_event.is_set():
            try:
                await recover_orphaned_jobs(
                    self.repo,
                    self.worker_id,
                    dead_after_s=self.settings.worker_dead_after_seconds,
                    stale_minutes=self.settings.stale_lock_minutes,
                    own_active=self.activity.jobs,
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
                        # navegador do robô para o ícone: none (fechado) | hidden | shown
                        "browser": robot_windows.state,
                        "browser_mode": self.settings.browser_window,  # hidden | visible
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
            self._write_local_status("busy" if self.activity.busy else "idle")
            await self._sleep(5)

    async def _update_watch(self) -> None:
        """Versão nova + robô ocioso há `update_idle_minutes`: encerra com calma para o serviço atualizar."""
        if not self.settings.update_enabled:
            return
        from app.updater import is_newer, latest_release, write_status

        next_check = 0.0
        latest = None
        while not self.stop_event.is_set():
            now = time.monotonic()
            if now >= next_check:
                next_check = now + self.settings.update_check_minutes * 60
                try:
                    latest = await asyncio.to_thread(latest_release, self.settings)
                    write_status(self.settings, latest)
                except Exception as exc:  # noqa: BLE001 - sem internet: tenta na próxima
                    log.debug("Consulta de atualização falhou: %s", exc)
            if (
                latest
                and is_newer(latest.version)
                and self.activity.idle_for(now) >= self.settings.update_idle_minutes * 60
            ):
                log.warning("Versão %s disponível e robô ocioso: encerrando para atualizar.", latest.version)
                self.settings.update_flag.write_text(latest.version, encoding="utf-8")
                self.stop()
                return
            await self._sleep(60)

    async def _watch_stop_flag(self) -> None:
        """parar-robo.bat cria o arquivo-sinal: encerra com calma (o job atual termina)."""
        flag = self.settings.stop_flag
        while not self.stop_event.is_set():
            if flag.exists():
                log.warning("Pedido de parada recebido (%s).", flag)
                self.stop()
                return
            if self.settings.update_flag.exists():
                # "Atualizar agora" no ícone: termina o trabalho atual e o serviço atualiza
                log.warning("Pedido de atualização recebido; encerrando após o trabalho atual.")
                self.stop()
                return
            await self._sleep(3)

    async def handle_browser_flag(self) -> bool:
        """Ícone "Mostrar/Esconder navegador do robô" grava o pedido em storage/navegador.flag."""
        flag = self.settings.browser_flag
        try:
            wanted = flag.read_text(encoding="utf-8").strip().lower()
        except OSError:
            return False
        flag.unlink(missing_ok=True)
        if wanted in ("visivel", "oculto"):
            # "Deixar navegador sempre visível" no ícone (o .env já foi gravado por ele)
            self.settings.browser_window = "visible" if wanted == "visivel" else "hidden"
            await robot_windows.set_always_visible(wanted == "visivel")
            log.info("Navegador do robô: %s.", "sempre visível" if wanted == "visivel" else "volta a trabalhar escondido")
            done = True
        elif wanted == "mostrar":
            done = await robot_windows.show(reason="user")
        elif wanted == "esconder":
            done = await robot_windows.hide()
        else:
            return False
        if done and wanted in ("mostrar", "esconder"):
            log.info("Navegador do robô: %s a pedido do ícone.", "mostrado" if wanted == "mostrar" else "escondido")
        self._write_local_status("busy" if self.activity.busy else "idle")
        return done

    async def _watch_browser_flag(self) -> None:
        while not self.stop_event.is_set():
            try:
                if self.settings.browser_flag.exists():
                    await self.handle_browser_flag()
                elif robot_windows.state == "hidden":
                    guarded = await robot_windows.guard_focus()
                    if guarded == "shown":
                        log.info("Navegador do robô: mostrado (clique no botão do Chrome na barra de tarefas).")
                        self._write_local_status("busy" if self.activity.busy else "idle")
                    elif guarded == "focus":
                        log.debug("Navegador do robô escondido pegou o foco; devolvido.")
            except Exception:
                log.exception("Falha ao mostrar/esconder o navegador do robô")
            await self._sleep(0.5)

    async def run(self) -> None:
        # antes de qualquer trabalho: a pasta das notas só é usada se for deste escritório
        await self._resolve_office()
        tasks: list[asyncio.Task] = [
            asyncio.create_task(self._heartbeat(), name="heartbeat"),
            asyncio.create_task(self._maintenance(), name="maintenance"),
            asyncio.create_task(self._watch_stop_flag(), name="stop-flag"),
            asyncio.create_task(self._watch_browser_flag(), name="browser-flag"),
            asyncio.create_task(self._local_status(), name="local-status"),
            asyncio.create_task(self._recovery(), name="recovery"),
            asyncio.create_task(self._session(), name="session"),
            asyncio.create_task(self._update_watch(), name="update-watch"),
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
    """Pastas em ano/mês/cliente, com o nome da empresa (renomeia 'CLI000001' e nomes antigos)."""
    try:
        organizer = organizer_for(settings)
        await asyncio.to_thread(organizer.reorganize)
        rows = (await client.table("clients").select("client_code, legal_name, trade_name").execute()).data or []
        names = {r["client_code"]: r.get("trade_name") or r.get("legal_name") for r in rows}
        await asyncio.to_thread(organizer.sync_client_names, names)
    except Exception as exc:  # noqa: BLE001 - pasta indisponível/sem internet: tenta no próximo início
        log.warning("Não foi possível organizar as pastas dos clientes: %s", exc)


def _network_errors() -> tuple[type[BaseException], ...]:
    import httpx
    from supabase_auth.errors import AuthRetryableError

    return (httpx.TransportError, AuthRetryableError, OSError)


async def connect_when_online(settings: Settings, sleep=asyncio.sleep):  # noqa: ANN001, ANN201
    """Conexão com o banco; sem internet (ex.: o notebook acabou de acordar), espera e tenta de
    novo em vez de cair. None = pediram para parar ou atualizar enquanto esperava."""
    delay, waited = 5.0, False
    while True:
        try:
            client = await get_supabase(settings)
        except _network_errors() as exc:
            reset_supabase_client()
            if not waited:
                log.warning("Sem conexão com o banco (%s). Esperando a internet voltar para começar.", exc)
                waited = True
            if settings.stop_flag.exists() or settings.update_flag.exists():
                return None
            await sleep(delay)
            delay = min(delay * 2, 60.0)
            continue
        if waited:
            log.info("Conexão de volta: o robô vai começar.")
        return client


async def amain(mode: str) -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_file)
    settings.stop_flag.unlink(missing_ok=True)  # sinal antigo não derruba o worker novo
    settings.browser_flag.unlink(missing_ok=True)  # pedido de mostrar navegador de uma sessão anterior
    settings.update_flag.unlink(missing_ok=True)  # o serviço já tratou a atualização antes de ligar o robô
    organizer = organizer_for(settings)
    try:
        organizer.check_available()
        log.info("Downloads serão salvos em %s", settings.downloads_dir)
    except DownloadFolderUnavailable as exc:
        if isinstance(organizer, FallbackOrganizer):
            log.warning(
                "Pasta de downloads indisponível agora (%s); as notas vão para %s até ela voltar.",
                exc,
                settings.local_downloads_dir,
            )
        else:
            log.warning("Pasta de downloads indisponível agora (%s); o collector tentará de novo mais tarde.", exc)
    _clear_stale_chrome_policy(settings)
    client = await connect_when_online(settings)
    if client is None:
        log.info("Pedido de parar ou atualizar enquanto esperava a internet.")
        return
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
    except Exception:
        # fica no worker.log (que não é apagado a cada início, como o worker-erros.log)
        log.exception("O robô parou por um erro inesperado; o serviço vai religá-lo")
        raise


if __name__ == "__main__":
    main()
