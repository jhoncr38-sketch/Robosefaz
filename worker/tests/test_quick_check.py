"""Conferência rápida (1.2.35): depois de agendar, com o navegador ainda aberto, o robô confere a lista
do SIAT e baixa o que já ficou pronto, em vez de fechar e esperar 30 min. Inclui o agendamento que já
existia no SIAT (feito à mão antes) e já está "Processado".

É um bônus: qualquer falha nela só registra um aviso e o trabalho segue para a consulta normal; nunca
agenda nem exclui nada. Só contribuinte errado e cancelamento interrompem o trabalho.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from app.jobs.collector_runner import CollectorRunner
from app.jobs.errors import AutomationError, ErrorCode, TaxpayerMismatchError
from app.jobs.models import DocumentType, ExportStatus, TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client


def _setup(repo: FakeRepo, *, seconds: float = 180, interval: float = 60, **job_kw):  # noqa: ANN003, ANN202
    repo.settings["quick_check_seconds"] = seconds
    repo.settings["quick_check_interval_seconds"] = interval
    client = make_client()
    repo.add_client(client, make_certificate(client))
    return repo.add_job(client, **job_kw)


def _exports(repo: FakeRepo, job_id: str) -> dict[TaskType, dict]:
    return {t["task_type"]: t for t in repo.tasks_of(job_id) if t.get("dedup_key")}


def _checks(provider: FakeProvider) -> int:
    return sum(1 for c in provider.calls if c == "check_status")


async def test_ready_files_are_downloaded_before_closing_the_browser(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    """Tudo já processado (ex.: agendamento feito à mão antes): baixa na 1ª conferência, sem espera."""
    job = _setup(repo)
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    started = time.monotonic()
    assert await SchedulerRunner(deps).run_once()
    assert time.monotonic() - started < 10  # nenhuma espera de 60 s
    j = repo.job(job.id)
    assert j["status"] == "completed" and j["progress"] == 100
    assert len(repo.downloads) == 3
    assert _checks(provider) == 1
    assert {TaskStatus(t["status"]) for t in _exports(repo, job.id).values()} == {TaskStatus.COMPLETED}
    # uma única entrada no SIAT: o navegador só abriu uma vez
    assert provider.calls.count("open_session") == 1 and provider.calls.count("login") == 1
    # a conferência fica registrada no histórico como rápida
    checks = [t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.CHECK_PROCESSING]
    assert checks and checks[0]["result"].get("quick") is True


async def test_quick_check_already_knows_each_request_number(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    """Visto no teste ao vivo de 08/10: a conferência rápida precisa receber o número de cada pedido
    que acabou de ser agendado (senão o robô tem de recuperá-lo pela data de criação)."""
    _setup(repo)
    seen: list[str | None] = []
    original = provider.check_status

    async def spy(ctx, tasks):  # noqa: ANN001, ANN202
        seen.extend(t.external_request_id for t in tasks)
        return await original(ctx, tasks)

    provider.check_status = spy  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    assert seen[:3] == ["PROT-NFCE_EXPORT", "PROT-NFE_ISSUED_EXPORT", "PROT-NFE_RECEIVED_EXPORT"]


async def test_partly_ready_downloads_what_it_can_and_leaves_the_rest_for_the_collector(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    job = _setup(repo, seconds=0.6, interval=0.2)
    provider.statuses = {DocumentType.NFCE: ExportStatus.PROCESSED}  # as NF-e seguem processando
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz"
    assert j["next_check_at"] > datetime.now(timezone.utc) + timedelta(minutes=29)
    assert _checks(provider) >= 2  # conferiu mais de uma vez dentro do limite
    tasks = _exports(repo, job.id)
    assert TaskStatus(tasks[TaskType.NFCE_EXPORT]["status"]) == TaskStatus.COMPLETED
    assert TaskStatus(tasks[TaskType.NFE_ISSUED_EXPORT]["status"]) == TaskStatus.SCHEDULED
    assert TaskStatus(tasks[TaskType.NFE_RECEIVED_EXPORT]["status"]) == TaskStatus.SCHEDULED
    assert len(repo.downloads) == 1
    assert any("1 de 3 pedido(s) já resolvido(s)" in m for m in repo.log_messages())
    # o Collector depois só cuida do que faltou
    repo.job(job.id)["next_check_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    provider.calls.clear()
    assert await CollectorRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed"
    assert [c for c in provider.calls if c.startswith("download")] == [
        "download:NFE_EMITIDAS",
        "download:NFE_RECEBIDAS",
    ]


async def test_nothing_ready_keeps_todays_behaviour(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo, seconds=0.3, interval=0.1)
    assert await SchedulerRunner(deps).run_once()  # FakeProvider: tudo "processando"
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz" and j.get("error_code") is None
    assert repo.downloads == []
    assert {TaskStatus(t["status"]) for t in _exports(repo, job.id).values()} == {TaskStatus.SCHEDULED}


async def test_no_notes_in_the_period_completes_on_the_spot(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo)
    provider.statuses = {d: ExportStatus.EMPTY for d in DocumentType}
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert "sem notas no período" in j["last_message"]
    assert repo.downloads == []


async def test_siat_failure_during_the_quick_check_is_not_an_error(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    """SIAT fora do ar/internet na conferência rápida: só um aviso; segue para a consulta normal."""
    job = _setup(repo)

    async def broken(ctx, tasks):  # noqa: ANN001, ANN202
        provider.calls.append("check_status")
        raise AutomationError(ErrorCode.SIAT_UNAVAILABLE, "ERRO 503: aplicação temporariamente indisponível")

    provider.check_status = broken  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz"
    assert j.get("error_code") is None
    assert not any("retentativa" in m for m in repo.log_messages())  # não gastou tentativa
    assert j["next_check_at"] > datetime.now(timezone.utc) + timedelta(minutes=29)
    assert {TaskStatus(t["status"]) for t in _exports(repo, job.id).values()} == {TaskStatus.SCHEDULED}
    assert any("Conferência rápida não foi possível" in m for m in repo.log_messages())
    # nada foi agendado de novo
    assert [c for c in provider.calls if c.startswith("schedule")] == [
        "schedule:NFCE_EXPORT",
        "schedule:NFE_ISSUED_EXPORT",
        "schedule:NFE_RECEIVED_EXPORT",
    ]


async def test_unexpected_error_during_the_quick_check_is_not_an_error_either(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    job = _setup(repo)

    async def broken(ctx, tasks):  # noqa: ANN001, ANN202
        raise RuntimeError("Target page, context or browser has been closed")

    provider.check_status = broken  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "waiting_sefaz"


async def test_wrong_taxpayer_during_the_quick_check_stops_the_job(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    job = _setup(repo)

    async def wrong(ctx, tasks):  # noqa: ANN001, ANN202
        raise TaxpayerMismatchError("IE 123456789", "IE 987654321", security=True)

    provider.check_status = wrong  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "failed"
    assert j["error_code"] == ErrorCode.SECURITY_CLIENT_MISMATCH.value


async def test_download_that_fails_is_left_for_the_collector(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo)
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    provider.download_errors = {DocumentType.NFCE: AutomationError(ErrorCode.DOWNLOAD_FAILED, "Tempo esgotado aguardando o download.")}
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz"
    # a próxima consulta vem antes (5 min, como numa falha de download do Collector)
    assert j["next_check_at"] < datetime.now(timezone.utc) + timedelta(minutes=6)
    tasks = _exports(repo, job.id)
    assert TaskStatus(tasks[TaskType.NFCE_EXPORT]["status"]) == TaskStatus.PROCESSED
    assert TaskStatus(tasks[TaskType.NFE_ISSUED_EXPORT]["status"]) == TaskStatus.COMPLETED
    assert _checks(provider) == 1  # não insiste no download na mesma sessão


async def test_robot_stopping_skips_the_quick_check(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo)
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    deps.stopping = lambda: True
    assert await SchedulerRunner(deps).run_once()
    assert _checks(provider) == 0
    assert repo.job(job.id)["status"] == "waiting_sefaz"
    assert any("conferência rápida pulada" in m for m in repo.log_messages())


async def test_robot_stopping_during_the_wait_ends_it_early(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo, seconds=600, interval=300)
    flags = {"n": 0}

    def stopping() -> bool:
        flags["n"] += 1
        return flags["n"] > 2  # começa a encerrar logo depois da 1ª conferência

    deps.stopping = stopping
    started = time.monotonic()
    assert await SchedulerRunner(deps).run_once()
    assert time.monotonic() - started < 10  # não ficou os 5 min esperando
    assert _checks(provider) == 1
    assert repo.job(job.id)["status"] == "waiting_sefaz"


async def test_turned_off_in_the_settings(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    job = _setup(repo, seconds=0)
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    assert await SchedulerRunner(deps).run_once()
    assert _checks(provider) == 0
    assert repo.job(job.id)["status"] == "waiting_sefaz"


# -- SIAT simulado: agendamento que já existia e já está "Processado" ------------------

import pytest  # noqa: E402

from app.automation.siat.provider import SiatAutomationProvider  # noqa: E402
from mock_siat.site import MockState  # noqa: E402
from test_siat_integration import _context, _open, integration_settings  # noqa: E402,F401 - fixture reaproveitada


@pytest.mark.integration
async def test_existing_processed_request_is_reused_and_downloaded_in_the_same_session(
    repo: FakeRepo, integration_settings  # noqa: ANN001, F811
) -> None:
    """Alguém agendou à mão; o robô pede de novo, o SIAT responde "já existe ... ID", o robô reaproveita
    (sem duplicar), registra quando o pedido foi feito e baixa na mesma entrada no SIAT."""
    state = MockState(reject_duplicates=True)
    ctx, job = await _context(repo, integration_settings, operations=[TaskType.NFE_RECEIVED_EXPORT])
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        task = (await repo.list_tasks(job.id))[0]
        manual = await provider.schedule(ctx, task)  # o "agendamento à mão" feito antes
        again = await provider.schedule(ctx, task)  # o robô pedindo o mesmo mês
        assert again.external_request_id == manual.external_request_id
        assert again.raw_message.startswith("JA_EXISTENTE_NO_PORTAL")
        task.external_request_id = again.external_request_id
        task.status = TaskStatus.SCHEDULED
        statuses = await provider.check_status(ctx, [task])
        assert statuses[0].status == ExportStatus.PROCESSED
        stored = await provider.download(ctx, task, statuses[0])
    assert len(state.scheduled) == 1 and state.deleted == []
    assert stored.filepath.endswith(".zip")
    assert any("situação: Processado, feito em 24/09/2026 23:30:00" in m for m in repo.log_messages())


@pytest.mark.integration
async def test_each_check_reopens_the_list_because_siat_does_not_refresh_it(
    repo: FakeRepo, integration_settings  # noqa: ANN001, F811
) -> None:
    """Visto no teste ao vivo de 08/10: a lista de agendamentos do SIAT não se atualiza sozinha. Cada
    conferência abre a lista de novo pelo menu (não com F5, que poderia reenviar o pedido); senão o
    robô lia "aguardando" para sempre e fechava sem baixar o que já estava pronto."""
    state = MockState(export_status_sequence=["Aguardando processamento", "Aguardando processamento", "Processado"])
    ctx, job = await _context(repo, integration_settings, operations=[TaskType.NFE_ISSUED_EXPORT])
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        task = (await repo.list_tasks(job.id))[0]
        result = await provider.schedule(ctx, task)  # 1ª abertura da lista: "aguardando"
        task.external_request_id = result.external_request_id
        task.status = TaskStatus.SCHEDULED
        first = await provider.check_status(ctx, [task])  # abre de novo: ainda "aguardando"
        second = await provider.check_status(ctx, [task])  # abre de novo: agora "Processado"
        stored = await provider.download(ctx, task, second[0])
    assert first[0].status == ExportStatus.PROCESSING
    assert second[0].status == ExportStatus.PROCESSED
    assert stored.filepath.endswith(".zip")
    assert len(state.scheduled) == 1  # reabrir a lista nunca reenvia o pedido


# -- pausa automática (SEFAZ lenta) -------------------------------------------------

from app.jobs.quick_check import QuickCheckGovernor  # noqa: E402


def test_governor_pauses_after_three_clients_with_nothing_ready_and_probes_after() -> None:
    g = QuickCheckGovernor(misses_to_pause=3, pause_seconds=1800)
    assert g.should_run(0)
    assert not g.record(False, 10) and not g.record(False, 20)
    assert g.record(False, 30)  # 3º cliente seguido sem nada pronto: pausa
    assert not g.should_run(31) and g.should_run(30 + 1800)
    # acabou a pausa: o próximo cliente é teste; nada pronto de novo -> pausa na hora
    assert g.record(False, 2000)
    assert not g.should_run(2001)
    # teste deu certo: volta ao normal (precisa de 3 seguidos para pausar de novo)
    assert not g.record(True, 4000)
    assert not g.record(False, 4010) and not g.record(False, 4020)
    assert g.record(False, 4030)


def test_governor_any_result_resets_the_count() -> None:
    g = QuickCheckGovernor(misses_to_pause=3)
    g.record(False, 1)
    g.record(False, 2)
    assert not g.record(True, 3)  # um cliente com algo pronto zera a contagem
    assert not g.record(False, 4) and not g.record(False, 5)
    assert g.should_run(6)


async def test_slow_sefaz_pauses_the_quick_check_for_the_next_clients(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    """Três clientes seguidos sem nada pronto na hora: o 4º nem espera (fecha o navegador como antes)."""
    repo.settings["quick_check_seconds"] = 0.2
    repo.settings["quick_check_interval_seconds"] = 0.1
    client = make_client()
    repo.add_client(client, make_certificate(client))
    jobs = [repo.add_job(client, competence=c) for c in ("2026-03", "2026-04", "2026-05", "2026-06")]
    # FakeProvider: tudo "processando" (SEFAZ lenta)
    for _ in range(3):
        assert await SchedulerRunner(deps).run_once()
    checks_before = _checks(provider)
    assert checks_before >= 3
    assert any("pula a conferência por 30 min" in m for m in repo.log_messages())
    assert await SchedulerRunner(deps).run_once()  # 4º cliente: pausa automática
    assert _checks(provider) == checks_before
    assert any("Conferência rápida em pausa automática" in m for m in repo.log_messages())
    assert all(repo.job(j.id)["status"] == "waiting_sefaz" for j in jobs)


async def test_after_the_pause_a_client_with_files_ready_brings_it_back(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    job = _setup(repo)
    deps.quick_check.paused_until = 0.0  # a pausa acabou
    deps.quick_check.probing = True  # este cliente é o teste
    provider.statuses = {d: ExportStatus.PROCESSED for d in DocumentType}
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed"
    assert deps.quick_check.probing is False
    assert any("voltou ao normal" in m for m in repo.log_messages())


async def test_robot_stopping_mid_check_does_not_count_as_slow_sefaz(
    repo: FakeRepo, provider: FakeProvider, deps  # noqa: ANN001
) -> None:
    _setup(repo, seconds=600, interval=300)
    calls = {"n": 0}

    def stopping() -> bool:
        calls["n"] += 1
        return calls["n"] > 2

    deps.stopping = stopping
    assert await SchedulerRunner(deps).run_once()
    assert deps.quick_check.misses == 0
