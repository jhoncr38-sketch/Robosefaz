"""Integração Playwright real contra o SIAT SIMULADO (sem acesso à internet).

Segue o caminho real: login com certificado -> painel (CNPJ) -> e-AGEAT
(erro 500 / "Usuário não identificado" -> fechar e clicar de novo) ->
Autorregularização > SIAT -> SIAT web -> Consultar/Exportar NFC-e / NF-e ->
Agendar exportação -> lista (ID/Situação/IE) -> Download. Inclui as proteções
contra cliente errado (CNPJ no painel, IE no SIAT web).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.automation.base import AutomationContext
from app.automation.siat.provider import SiatAutomationProvider
from app.config import Settings
from app.downloads.organizer import DownloadOrganizer
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import ExportStatus, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger
from fakes import FakeRepo, make_certificate, make_client
from mock_siat.site import BASE, MockState, build_handler

pytestmark = pytest.mark.integration


@pytest.fixture
def integration_settings(settings: Settings) -> Settings:
    settings.siat_base_url = BASE  # domínio .invalid: nenhuma requisição chega à SEFAZ
    settings.automation_headless = True
    settings.browser_channel = "chromium"
    settings.automation_dry_run = False
    settings.login_detection_timeout = 8_000
    settings.certificate_selection_timeout = 3_000
    settings.action_timeout = 8_000
    settings.page_load_timeout = 15_000
    settings.module_retry_delay = 0.1
    return settings


async def _context(repo: FakeRepo, settings: Settings, *, subject: str | None = None, **client_kw):  # noqa: ANN003, ANN202
    client = make_client(**client_kw)
    cert = make_certificate(client, **({"subject_name": subject} if subject else {}))
    repo.add_client(client, cert)
    job = repo.add_job(client)
    logger = JobLogger(repo, job.id)
    reporter = JobReporter(repo, job, settings, logger, phase="schedule", initial=JobStatus.STARTING, poll_interval=0.1)
    ctx = AutomationContext(
        job=job,
        client=client,
        certificate=cert,
        settings=settings,
        reporter=reporter,
        logger=logger,
        organizer=DownloadOrganizer(settings.downloads_dir),
    )
    return ctx, job


async def _open(provider: SiatAutomationProvider, ctx: AutomationContext, state: MockState) -> None:
    assert ctx.page is not None
    await ctx.page.context.route(f"{BASE}/**", build_handler(state))
    await provider.login(ctx)
    await provider.select_company(ctx)


async def test_full_flow_schedule_check_download(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState()
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()

    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        assert "11.222.333/0001-81" in await ctx.page.locator("#current").inner_text()  # type: ignore[union-attr]

        tasks = await repo.list_tasks(job.id)
        results = [await provider.schedule(ctx, t) for t in tasks]
        assert [r.external_request_id for r in results] == ["9237950", "9237951", "9237952"]
        assert "/siatweb/" in ctx.page.url  # type: ignore[union-attr]

        for t, r in zip(tasks, results, strict=True):
            t.external_request_id = r.external_request_id
            t.status = TaskStatus.SCHEDULED
        statuses = await provider.check_status(ctx, tasks)
        assert [s.status for s in statuses] == [ExportStatus.PROCESSED] * 3

        stored = await provider.download(ctx, tasks[1], statuses[1])

    # parâmetros enviados ao "SIAT"
    nfce, issued, received = state.scheduled
    assert nfce == {"family": "nfce", "tipo": "emitente", "ie": "123456789", "nota": "saida",
                    "status": "todas", "ini": "01/08/2026", "fim": "31/08/2026", "id": "9237950"}
    assert (issued["family"], issued["tipo"], issued["ie"]) == ("nfe", "emitente", "123456789")
    assert (received["family"], received["tipo"]) == ("nfe", "destinatario")
    assert received["ini"] == "01/08/2026" and received["fim"] == "31/08/2026"

    path = Path(stored.filepath)
    assert path.name == "CLI000001_2026-08_NFE_EMITIDAS.zip"
    assert path.parent == (integration_settings.downloads_dir / "CLI000001" / "2026" / "08" / "NFE_EMITIDAS").resolve()
    assert stored.size > 0 and len(stored.checksum) == 64
    assert state.downloads_served == 1
    profile_root = integration_settings.profiles_dir / ctx.client.id
    assert (profile_root / "chrome").is_dir() and not (profile_root / ".siat.lock").exists()


async def test_dry_run_fills_form_but_never_schedules(repo: FakeRepo, integration_settings: Settings) -> None:
    integration_settings.automation_dry_run = True
    state = MockState()
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        result = await provider.schedule(ctx, (await repo.list_tasks(job.id))[0])
        assert result.dry_run and result.external_request_id is None
        assert await ctx.page.locator("#c-ini").input_value() == "01/08/2026"  # type: ignore[union-attr]
        assert await ctx.page.locator("#c-insc").input_value() == "123456789"  # type: ignore[union-attr]
    assert state.scheduled == []


async def test_wrong_taxpayer_in_panel_blocks(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState(force_header_cnpj="11.444.777/0001-61")
    ctx, _ = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await _open(provider, ctx, state)
    assert exc.value.code == ErrorCode.TAXPAYER_MISMATCH
    shot = ctx.state.get("error_screenshot")
    assert shot and Path(shot).exists() and Path(shot).name.startswith(ctx.job.id)


async def test_legacy_without_client_ie_blocks_before_scheduling(repo: FakeRepo, integration_settings: Settings) -> None:
    # SIAT web só oferece a IE de OUTRO contribuinte: nunca agendar.
    state = MockState(inscricoes=["987654321"])
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await _open(provider, ctx, state)
            await provider.schedule(ctx, (await repo.list_tasks(job.id))[0])
    assert exc.value.code == ErrorCode.SECURITY_CLIENT_MISMATCH
    assert state.scheduled == []


async def test_download_of_other_ie_is_blocked(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState(rows_ie_override="987654321")
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await _open(provider, ctx, state)
            task = next(t for t in await repo.list_tasks(job.id) if t.task_type == TaskType.NFE_ISSUED_EXPORT)
            result = await provider.schedule(ctx, task)
            task.external_request_id = result.external_request_id
            await provider.check_status(ctx, [task])
    assert exc.value.code == ErrorCode.SECURITY_CLIENT_MISMATCH
    assert state.downloads_served == 0


async def test_client_without_ie_is_invalid_configuration(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState()
    ctx, job = await _context(repo, integration_settings, state_registration=None)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await _open(provider, ctx, state)
            await provider.schedule(ctx, (await repo.list_tasks(job.id))[0])
    assert exc.value.code == ErrorCode.INVALID_CONFIGURATION
    assert state.scheduled == []


async def test_eageat_500_and_unidentified_close_and_click_again(repo: FakeRepo, integration_settings: Settings) -> None:
    # Observado no real: 500 e "Usuário não identificado"; o contorno é fechar e clicar de novo.
    state = MockState(module_fail_times=1, module_unidentified_times=1)
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        result = await provider.schedule(ctx, (await repo.list_tasks(job.id))[0])
        assert result.external_request_id == "9237950"
        # painel + a aba que abriu bem; as 2 abas com problema foram fechadas
        assert len(ctx.page.context.pages) == 2  # type: ignore[union-attr]
    assert state.module_opens == 3
    logs = repo.log_messages()
    assert any("erro do servidor (tentativa 1/5)" in m for m in logs)
    assert any("'Usuário não identificado' (tentativa 2/5)" in m for m in logs)


async def test_eageat_always_failing_is_retryable(repo: FakeRepo, integration_settings: Settings) -> None:
    integration_settings.module_open_attempts = 3
    state = MockState(module_fail_times=99)
    ctx, job = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await _open(provider, ctx, state)
            await provider.schedule(ctx, (await repo.list_tasks(job.id))[0])
    assert exc.value.code == ErrorCode.SIAT_UNAVAILABLE and exc.value.retryable
    assert state.module_opens == 3


async def test_certificate_not_listed_waits_for_user(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState()
    ctx, _ = await _context(repo, integration_settings, subject="OUTRA EMPRESA:04252011000110", cnpj="04252011000110")
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await ctx.page.context.route(f"{BASE}/**", build_handler(state))  # type: ignore[union-attr]
            await provider.login(ctx)
    assert exc.value.code == ErrorCode.MANUAL_ACTION_REQUIRED
    assert "waiting_certificate" in [u.get("status") for _, u in repo.job_updates]


async def test_stuck_callback_recovers_by_clearing_siat_data(repo: FakeRepo, integration_settings: Settings) -> None:
    integration_settings.login_detection_timeout = 3_000
    state = MockState()
    ctx, _ = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        assert ctx.page is not None
        await ctx.page.context.route(f"{BASE}/**", build_handler(state))
        await ctx.page.goto(f"{BASE}/painel-aplicacoes/login")
        await ctx.page.evaluate("localStorage.setItem('stale', '1')")
        await provider.login(ctx)
        assert "/painel-aplicacoes/main" in ctx.page.url
    logs = repo.log_messages()
    assert any("retorno do login (/callback) travou" in m for m in logs)
    assert any("Falha ao trocar o código" in m for m in logs)
    assert "waiting_certificate" not in [u.get("status") for _, u in repo.job_updates]


async def test_callback_that_never_finishes_fails_with_diagnostics(repo: FakeRepo, integration_settings: Settings) -> None:
    integration_settings.login_detection_timeout = 3_000
    state = MockState(callback_always_hangs=True)
    ctx, _ = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    with pytest.raises(AutomationError) as exc:
        async with provider.open_session(ctx):
            await ctx.page.context.route(f"{BASE}/**", build_handler(state))  # type: ignore[union-attr]
            await provider.login(ctx)
    assert exc.value.code == ErrorCode.LOGIN_FAILED
    assert "/callback" in exc.value.message and "Falha ao trocar o código" in exc.value.message


async def test_policy_failure_falls_back_to_manual(repo: FakeRepo, integration_settings: Settings) -> None:
    integration_settings.chrome_policy_mode = "per_job"
    integration_settings.chrome_policy_allow_write = False
    ctx, _ = await _context(repo, integration_settings)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        assert ctx.page is not None
    assert any("seleção do certificado será manual" in m for m in repo.log_messages())


def test_policy_pattern_covers_all_sefaz_hosts() -> None:
    from app.certificates.chrome_policy import ChromeCertificatePolicyService

    client = make_client()
    entry = ChromeCertificatePolicyService.entry_for_certificate(make_certificate(client), "https://[*.]sefaz.pi.gov.br")
    assert '"pattern":"https://[*.]sefaz.pi.gov.br"' in entry.to_policy_json()
