"""wait_for_user_confirmation(): pausa, confirmação pelo painel, resolução automática e timeout."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.jobs.errors import JobCancelled, ManualActionRequired
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger
from fakes import FakeRepo, make_client


def _reporter(repo: FakeRepo, settings, job) -> JobReporter:  # noqa: ANN001
    return JobReporter(
        repo,
        job,
        settings,
        JobLogger(repo, job.id),
        phase="schedule",
        initial=JobStatus.OPENING_SIAT,
        poll_interval=0.01,
    )


async def test_confirmed_by_user(repo: FakeRepo, settings) -> None:  # noqa: ANN001
    job = repo.add_job(make_client())
    rep = _reporter(repo, settings, job)

    async def user_clicks_continue() -> None:
        await asyncio.sleep(0.05)
        assert repo.job(job.id)["status"] == "manual_action_required"
        assert repo.job(job.id)["manual_action_message"] == "Resolva o CAPTCHA"
        repo.jobs[job.id]["manual_action_confirmed_at"] = datetime.now(timezone.utc)

    await asyncio.gather(rep.wait_for_user_confirmation("Resolva o CAPTCHA"), user_clicks_continue())
    assert repo.job(job.id)["status"] == "opening_siat"  # retoma a etapa anterior
    assert repo.job(job.id)["manual_action_message"] is None
    assert rep.state == JobStatus.OPENING_SIAT


async def test_resolved_automatically(repo: FakeRepo, settings) -> None:  # noqa: ANN001
    job = repo.add_job(make_client())
    rep = _reporter(repo, settings, job)
    calls = {"n": 0}

    async def logged_in() -> bool:
        calls["n"] += 1
        return calls["n"] >= 3

    await rep.wait_for_user_confirmation(
        "Aguardando seleção do certificado digital.", status=JobStatus.WAITING_CERTIFICATE, resolved=logged_in
    )
    statuses = [u.get("status") for _, u in repo.job_updates]
    assert "waiting_certificate" in statuses
    assert repo.job(job.id)["status"] == "opening_siat"


async def test_old_confirmation_is_ignored_and_times_out(repo: FakeRepo, settings) -> None:  # noqa: ANN001
    job = repo.add_job(make_client())
    repo.jobs[job.id]["manual_action_confirmed_at"] = datetime(2020, 1, 1, tzinfo=timezone.utc)
    rep = _reporter(repo, settings, job)
    with pytest.raises(ManualActionRequired):
        await rep.wait_for_user_confirmation("x", timeout_ms=100)


async def test_cancel_while_waiting(repo: FakeRepo, settings) -> None:  # noqa: ANN001
    job = repo.add_job(make_client())
    rep = _reporter(repo, settings, job)

    async def cancel() -> None:
        await asyncio.sleep(0.03)
        repo.jobs[job.id]["cancel_requested"] = True

    with pytest.raises(JobCancelled):
        await asyncio.gather(rep.wait_for_user_confirmation("x"), cancel())
