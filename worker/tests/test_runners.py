"""Scheduler (Robô 1) e Collector (Robô 2) com repositório em memória e portal simulado."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.jobs.collector_runner import CollectorRunner
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import DocumentType, ExportStatus, TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client


def _setup(repo: FakeRepo, **job_kw):  # noqa: ANN003, ANN202
    client = make_client()
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, **job_kw)
    return client, job


def _statuses(repo: FakeRepo, job_id: str) -> dict[TaskType, TaskStatus]:
    return {t["task_type"]: TaskStatus(t["status"]) for t in repo.tasks_of(job_id) if t.get("dedup_key")}


class TestScheduler:
    async def test_schedules_all_and_waits_sefaz(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo)
        assert await SchedulerRunner(deps).run_once()
        j = repo.job(job.id)
        assert j["status"] == "waiting_sefaz"
        assert j["progress"] == 80
        assert j["next_check_at"] > datetime.now(timezone.utc) + timedelta(minutes=29)
        assert set(_statuses(repo, job.id).values()) == {TaskStatus.SCHEDULED}
        assert [c for c in provider.calls if c.startswith("schedule")] == [
            "schedule:NFCE_EXPORT",
            "schedule:NFE_ISSUED_EXPORT",
            "schedule:NFE_RECEIVED_EXPORT",
        ]
        assert provider.calls[-1] == "close_session"  # navegador fechado após agendar
        assert job.id in repo.released
        # progresso reportado etapa a etapa
        steps = [u["status"] for _, u in repo.job_updates if "status" in u]
        assert steps[:3] == ["opening_browser", "opening_siat", "authenticating"]
        assert "scheduling_nfce" in steps and "scheduling_nfe_received" in steps

    async def test_external_ids_are_recorded(self, repo: FakeRepo, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo, operations=[TaskType.NFCE_EXPORT])
        await SchedulerRunner(deps).run_once()
        task = repo.tasks_of(job.id)[0]
        assert task["external_request_id"] == "PROT-NFCE_EXPORT"
        assert task["requested_at"] is not None

    async def test_dry_run_completes_without_scheduling(self, repo: FakeRepo, deps) -> None:  # noqa: ANN001
        deps.settings.automation_dry_run = True
        _, job = _setup(repo)
        await SchedulerRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "completed"
        assert set(_statuses(repo, job.id).values()) == {TaskStatus.DRY_RUN}
        assert "Simulação" in repo.job(job.id)["last_message"]

    async def test_duplicate_is_skipped(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        client, _ = _setup(repo, operations=[TaskType.NFCE_EXPORT], task_status=TaskStatus.SCHEDULED, status="waiting_sefaz")
        job2 = repo.add_job(client, [TaskType.NFCE_EXPORT, TaskType.NFE_ISSUED_EXPORT])
        await SchedulerRunner(deps).run_once()
        st = _statuses(repo, job2.id)
        assert st[TaskType.NFCE_EXPORT] == TaskStatus.SKIPPED
        assert st[TaskType.NFE_ISSUED_EXPORT] == TaskStatus.SCHEDULED
        assert "schedule:NFCE_EXPORT" not in provider.calls
        assert any("Exportação já agendada" in m for m in repo.log_messages())

    async def test_force_reschedules(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        client, _ = _setup(repo, operations=[TaskType.NFCE_EXPORT], task_status=TaskStatus.SCHEDULED, status="waiting_sefaz")
        job2 = repo.add_job(client, [TaskType.NFCE_EXPORT], force=True)
        await SchedulerRunner(deps).run_once()
        assert _statuses(repo, job2.id)[TaskType.NFCE_EXPORT] == TaskStatus.SCHEDULED

    async def test_taxpayer_mismatch_fails_without_retry(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.select_error = TaxpayerMismatchError("11.222.333/0001-81", "11.444.777/0001-61")
        _, job = _setup(repo)
        await SchedulerRunner(deps).run_once()
        j = repo.job(job.id)
        assert j["status"] == "failed"
        assert j["error_code"] == "TAXPAYER_MISMATCH"
        assert not any(c.startswith("schedule:") for c in provider.calls)
        assert set(_statuses(repo, job.id).values()) == {TaskStatus.FAILED}

    async def test_security_mismatch_before_schedule(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.schedule_error[TaskType.NFCE_EXPORT] = TaxpayerMismatchError("a", "b", security=True)
        _, job = _setup(repo)
        await SchedulerRunner(deps).run_once()
        assert repo.job(job.id)["error_code"] == "SECURITY_CLIENT_MISMATCH"
        assert repo.job(job.id)["status"] == "failed"

    async def test_retryable_error_requeues_with_backoff(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.login_error = AutomationError(ErrorCode.SIAT_UNAVAILABLE, "fora do ar")
        _, job = _setup(repo, attempts=0)
        before = datetime.now(timezone.utc)
        await SchedulerRunner(deps).run_once()  # tentativa 1 falha
        j = repo.job(job.id)
        assert j["status"] == "queued"
        assert j["error_code"] == "SIAT_UNAVAILABLE"
        assert timedelta(seconds=9) < j["next_attempt_at"] - before < timedelta(seconds=12)
        assert set(_statuses(repo, job.id).values()) == {TaskStatus.PENDING}

    async def test_retry_limit(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.login_error = AutomationError(ErrorCode.TIMEOUT, "timeout")
        _, job = _setup(repo, attempts=3)  # próxima execução é a 4ª (3 retentativas já usadas)
        await SchedulerRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "failed"

    async def test_missing_certificate(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        client = make_client()
        repo.add_client(client, None)
        job = repo.add_job(client)
        await SchedulerRunner(deps).run_once()
        j = repo.job(job.id)
        assert j["status"] == "certificate_required"
        assert j["error_code"] == "CERTIFICATE_REQUIRED"
        assert provider.calls == []  # navegador nem é aberto

    async def test_expired_certificate(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        client = make_client()
        repo.add_client(client, make_certificate(client, valid_until=datetime.now(timezone.utc) - timedelta(days=1)))
        job = repo.add_job(client)
        await SchedulerRunner(deps).run_once()
        assert repo.job(job.id)["error_code"] == "CERTIFICATE_EXPIRED"
        assert provider.calls == []

    async def test_cancel_during_run(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo)
        provider.on_schedule = lambda task: repo.jobs[job.id].update(cancel_requested=True)
        await SchedulerRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "cancelled"
        st = _statuses(repo, job.id)
        assert st[TaskType.NFCE_EXPORT] == TaskStatus.SCHEDULED
        assert st[TaskType.NFE_ISSUED_EXPORT] == TaskStatus.CANCELLED

    async def test_no_job(self, deps) -> None:  # noqa: ANN001
        assert await SchedulerRunner(deps).run_once() is False


class TestCollector:
    async def test_downloads_processed_and_completes(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
        assert await CollectorRunner(deps).run_once()
        j = repo.job(job.id)
        assert j["status"] == "completed" and j["progress"] == 100
        assert len(repo.downloads) == 3
        names = sorted(d["filename"] for d in repo.downloads)
        assert names == [
            "CLI000001_2026-08_NFCE.zip",
            "CLI000001_2026-08_NFE_EMITIDAS.zip",
            "CLI000001_2026-08_NFE_RECEBIDAS.zip",
        ]
        for d in repo.downloads:
            p = Path(d["filepath"])
            assert p.exists() and p.parent.name == d["document_type"]
            assert p.parent.parent.name == "08" and p.parent.parent.parent.name == "2026"
            assert len(d["checksum"]) == 64
        types = [t["task_type"] for t in repo.tasks_of(job.id)]
        assert types.count(TaskType.DOWNLOAD) == 3 and types.count(TaskType.CHECK_PROCESSING) == 1

    async def test_still_processing_goes_back_to_waiting(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        provider.statuses = {DocumentType.NFCE: ExportStatus.PROCESSED}
        await CollectorRunner(deps).run_once()
        j = repo.job(job.id)
        assert j["status"] == "waiting_sefaz"
        assert j["next_check_at"] > datetime.now(timezone.utc)
        st = _statuses(repo, job.id)
        assert st[TaskType.NFCE_EXPORT] == TaskStatus.COMPLETED
        assert st[TaskType.NFE_ISSUED_EXPORT] == TaskStatus.SCHEDULED
        assert len(repo.downloads) == 1

    async def test_exhausted_checks_fail(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        repo.settings["collector_max_checks"] = 3
        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED, check_count=2)
        await CollectorRunner(deps).run_once()
        assert repo.job(job.id)["error_code"] == "COLLECTOR_EXHAUSTED"

    async def test_sefaz_error_marks_task_failed(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        _, job = _setup(repo, operations=[TaskType.NFCE_EXPORT], status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        provider.statuses = {DocumentType.NFCE: ExportStatus.ERROR}
        await CollectorRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "failed"
        assert repo.job(job.id)["error_code"] == "EXPORT_FAILED"

    async def test_transient_error_keeps_waiting(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.login_error = AutomationError(ErrorCode.SIAT_UNAVAILABLE, "fora do ar")
        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        await CollectorRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "waiting_sefaz"
        assert repo.job(job.id)["error_code"] == "SIAT_UNAVAILABLE"

    async def test_security_error_fails(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        provider.select_error = TaxpayerMismatchError("a", "b", security=True)
        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        await CollectorRunner(deps).run_once()
        assert repo.job(job.id)["status"] == "failed"
        assert len(repo.downloads) == 0


class TestWorkerInterrupt:
    async def test_interrupted_scheduler_job_returns_to_queue(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        import asyncio

        _, job = _setup(repo, attempts=0)
        started = asyncio.Event()

        async def hang(ctx):  # noqa: ANN001, ANN202
            started.set()
            await asyncio.sleep(3600)

        provider.login = hang  # type: ignore[method-assign]
        task = asyncio.create_task(SchedulerRunner(deps).run_once())
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        j = repo.job(job.id)
        assert j["status"] == "queued"
        assert j["attempts"] == 0  # interrupção não conta como tentativa
        assert j["locked_by"] is None and job.id in repo.released
        assert "close_session" in provider.calls  # navegador fechado

    async def test_interrupted_collector_job_waits_again(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        import asyncio

        _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
        started = asyncio.Event()

        async def hang(ctx, tasks):  # noqa: ANN001, ANN202
            started.set()
            await asyncio.sleep(3600)

        provider.check_status = hang  # type: ignore[method-assign]
        task = asyncio.create_task(CollectorRunner(deps).run_once())
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert repo.job(job.id)["status"] == "waiting_sefaz"
        assert repo.job(job.id)["locked_by"] is None


class TestNoDuplicateAfterSubmit:
    async def test_failure_after_click_never_resubmits(self, repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
        # O clique em "Agendar exportação" aconteceu, mas o robô falhou antes de ler o ID.
        _, job = _setup(repo, operations=[TaskType.NFCE_EXPORT, TaskType.NFE_ISSUED_EXPORT], attempts=0)
        original = provider.schedule
        state = {"first": True}

        async def schedule_then_crash(ctx, task):  # noqa: ANN001, ANN202
            if state["first"] and task.task_type == TaskType.NFCE_EXPORT:
                state["first"] = False
                await ctx.on_submit()  # o robô clicou no botão final...
                raise AutomationError(ErrorCode.TIMEOUT, "página travou após o clique")  # ...e caiu
            return await original(ctx, task)

        provider.schedule = schedule_then_crash  # type: ignore[method-assign]
        await SchedulerRunner(deps).run_once()
        st = _statuses(repo, job.id)
        assert st[TaskType.NFCE_EXPORT] == TaskStatus.SCHEDULED  # já conta como enviado
        assert repo.job(job.id)["status"] == "queued"  # retentativa agendada

        repo.jobs[job.id]["next_attempt_at"] = None
        provider.calls.clear()
        await SchedulerRunner(deps).run_once()
        assert "schedule:NFCE_EXPORT" not in provider.calls  # NUNCA reenviado
        assert "schedule:NFE_ISSUED_EXPORT" in provider.calls
        assert repo.job(job.id)["status"] == "waiting_sefaz"
        nfce = next(t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.NFCE_EXPORT)
        assert nfce["requested_at"] is not None and not nfce.get("external_request_id")


async def test_worker_stops_when_flag_file_appears(settings) -> None:
    """parar-robo.bat cria o arquivo-sinal; o worker encerra sozinho."""
    import asyncio

    from app.worker import Worker

    worker = Worker(FakeRepo(), settings, mode="none")
    settings.stop_flag.write_text("parar", encoding="utf-8")
    await asyncio.wait_for(worker.run(), timeout=10)
    assert worker.stop_event.is_set()
