"""Repasse: computador sem o certificado do cliente devolve o trabalho para outro do escritório."""

from __future__ import annotations

import pytest

from app.certificates.certificate_manager import CertificateManager
from app.jobs.collector_runner import CollectorRunner
from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode
from app.jobs.models import TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client


async def _empty_store() -> list:
    return []  # Windows sem o certificado do cliente


def _setup(repo: FakeRepo, *, status: str = "queued", task_status: TaskStatus = TaskStatus.PENDING):  # noqa: ANN202
    client = make_client()
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.NFCE_EXPORT], status=status, task_status=task_status)
    return client, job


@pytest.fixture
def no_cert_here(deps):  # noqa: ANN001, ANN201
    deps.certificate_manager = CertificateManager(require_installed=True, store_loader=_empty_store)
    return deps


async def test_certificate_missing_on_this_pc_is_a_local_error() -> None:
    client = make_client()
    manager = CertificateManager(require_installed=True, store_loader=_empty_store)
    with pytest.raises(CertificateNotInstalledError) as exc:
        await manager.ensure_ready(client, make_certificate(client))
    assert exc.value.code == ErrorCode.CERTIFICATE_REQUIRED


async def test_scheduler_hands_the_job_to_another_pc(repo: FakeRepo, provider: FakeProvider, no_cert_here) -> None:  # noqa: ANN001
    repo.other_hosts = ["ALEX"]
    _, job = _setup(repo)
    await SchedulerRunner(no_cert_here).run_once()
    j = repo.job(job.id)
    assert j["status"] == "queued"  # volta para a fila, para o outro computador
    assert j["skip_hosts"] == ["test-worker"]  # este não pega de novo
    assert repo.handovers == [(job.id, "test-worker", False)]
    assert not any(c.startswith("schedule:") for c in provider.calls)
    assert any("repassado para: ALEX" in m for m in repo.log_messages())
    assert not j.get("error_code")


async def test_no_other_pc_left_marks_certificate_required(repo: FakeRepo, provider: FakeProvider, no_cert_here) -> None:  # noqa: ANN001
    repo.other_hosts = ["ALEX"]
    _, job = _setup(repo)
    repo.jobs[job.id]["skip_hosts"] = ["ALEX"]  # o Alex já tentou e também não tem
    await SchedulerRunner(no_cert_here).run_once()
    j = repo.job(job.id)
    assert j["status"] == "certificate_required"
    assert "tentado em: ALEX, test-worker" in j["error_message"]
    assert "Reprocessar" in j["error_message"]


async def test_collector_hands_the_check_to_another_pc(repo: FakeRepo, provider: FakeProvider, no_cert_here) -> None:  # noqa: ANN001
    repo.other_hosts = ["ALEX"]
    _, job = _setup(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
    await CollectorRunner(no_cert_here).run_once()
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz" and j["skip_hosts"] == ["test-worker"]
    assert repo.handovers == [(job.id, "test-worker", True)]
    assert "check_status" not in provider.calls


async def test_expired_certificate_is_not_handed_over(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    """Vencido vale para todos os computadores: não adianta repassar."""
    repo.other_hosts = ["ALEX"]
    _, job = _setup(repo)

    async def expired(client, certificate, **_kw):  # noqa: ANN001, ANN202
        raise AutomationError(ErrorCode.CERTIFICATE_EXPIRED, "Certificado venceu.")

    deps.certificate_manager.ensure_ready = expired  # type: ignore[method-assign]
    await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "certificate_required"
    assert repo.handovers == []
