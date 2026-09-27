"""Consulta do processamento da EFD (tarefa EFD_CHECK) com DT-e simulado."""

from __future__ import annotations

from app.automation.siat.siat_dte import DteMessage
from app.jobs.efd_check import summary
from app.jobs.errors import ErrorCode
from app.jobs.models import TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client
from test_efd_parser import ALERT, NOT_PROCESSED, PROCESSED, RETIFICADORA

BEZERRA = {"cnpj": "28100366000151", "state_registration": "196034990"}
SETEL = {"cnpj": "05731045000150", "state_registration": "194558231"}


def _setup(repo: FakeRepo, competence: str, **client_kw):  # noqa: ANN003, ANN202
    client = make_client(**client_kw)
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.EFD_CHECK], competence=competence)
    return client, job


async def test_processed_declaration_is_saved_and_job_completes(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _setup(repo, "2026-08", **BEZERRA)
    provider.efd_messages = [DteMessage(subject="EPE - EFD - Período 202608 - 93104981381", text=PROCESSED)]
    assert await SchedulerRunner(deps).run_once()

    assert "read_efd:2026-08" in provider.calls
    assert not any(c.startswith("schedule:") for c in provider.calls)  # nada é agendado
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "EFD 08/2026: processada (original)."
    (decl,) = repo.efd
    assert decl["epe_number"] == "93104981381"
    assert decl["situation"] == "processed"
    assert decl["finalidade"] == "ORIGINAL"
    (task,) = repo.tasks_of(job.id)
    assert task["status"] == TaskStatus.COMPLETED
    assert task["result"]["situation"] == "processed"


async def test_retificadora_wins_over_rejected_original(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _setup(repo, "2026-07", **SETEL)
    provider.efd_messages = [
        DteMessage(subject="EPE - EFD - Período 202607 - 93104801993", text=RETIFICADORA),
        DteMessage(subject="EPE - EFD - Período 202607 - 93104780277", text=NOT_PROCESSED),
    ]
    await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["last_message"] == "EFD 07/2026: processada (retificadora)."
    assert {d["epe_number"]: d["situation"] for d in repo.efd} == {
        "93104801993": "processed",
        "93104780277": "not_processed",
    }


async def test_nothing_found(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _setup(repo, "2026-09", **BEZERRA)
    await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "EFD 09/2026: nenhuma mensagem de processamento no DT-e."
    assert repo.tasks_of(job.id)[0]["result"]["found"] == 0


async def test_message_of_other_taxpayer_is_never_saved(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    # cliente é a SETEL, mas a caixa mostrou mensagem da C BEZERRA
    _, job = _setup(repo, "2026-08", **SETEL)
    provider.efd_messages = [DteMessage(subject="EPE - EFD - Período 202608 - 93104981381", text=PROCESSED)]
    await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "failed"
    assert j["error_code"] == ErrorCode.SECURITY_CLIENT_MISMATCH.value
    assert getattr(repo, "efd", []) == []


def test_summary_texts() -> None:
    from app.efd.parser import parse_message

    assert summary("2026-06", [parse_message(ALERT)]) == "EFD 06/2026: processada com malha fiscal (alerta) (original)."  # type: ignore[list-item]
    assert summary("2026-07", [parse_message(NOT_PROCESSED)]) == "EFD 07/2026: NÃO processada (original)."  # type: ignore[list-item]
