"""Nota pela chave (1.2.34): a pessoa digita a chave na tela Notas, escolhe a empresa e o robô
exporta só aquela nota no SIAT ("Pesquisar SOMENTE pela Chave da NFE" -> Exportar).

Como visto no SIAT real em 06/10/2026, o "Exportar" pela chave entrega o ZIP da nota NO CLIQUE
(sem agendamento e sem linha nova na lista); ZIP vazio quando a nota não é do contribuinte.

- organizer: o ZIP vai para ano/mês/cliente/tipo/Avulsas/NFe <chave> - <código>.zip (não é ZIP do mês);
- scheduler: recebe o arquivo no clique, registra o download com a chave, indexa na hora e conclui;
- collector: se o SIAT algum dia agendar em vez de entregar, segue o caminho normal (também com a chave);
- SIAT simulado: formulário da chave, download direto, ZIP vazio e recusa.
"""

from __future__ import annotations

import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.automation.siat.provider import SiatAutomationProvider
from app.config import Settings
from app.downloads.note_index import index_zip
from app.downloads.organizer import AVULSA_FILE, DownloadOrganizer, avulsa_filename, is_note_file
from app.jobs.collector_runner import CollectorRunner
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import DocumentType, ExportRequestResult, ExportStatus, TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from fakes import FakeProvider, FakeRepo, make_certificate, make_client
from mock_siat.site import EMPTY_ZIP, MockState, nfe_zip
from test_siat_integration import _context, _open, integration_settings  # noqa: F401 - fixture reaproveitada

KEY = "22260806057223046163553000001722801561303961"  # NF-e do Assaí (emitente de fora), 08/2026


# -- organizer -----------------------------------------------------------------


def test_avulsa_has_its_own_subfolder_and_name(tmp_path: Path) -> None:
    org = DownloadOrganizer(tmp_path / "notas")
    src = tmp_path / "a.zip"
    src.write_bytes(nfe_zip(KEY))
    stored = org.store(src, "CLI000036", "2026-08", DocumentType.NFE_RECEBIDAS, "BOLITOS CONFEITARIA", note_key=KEY)
    p = Path(stored.filepath)
    assert p.name == f"NFe {KEY} - CLI000036.zip"
    assert p.parent.name == "Avulsas" and p.parent.parent.name == "NFE_RECEBIDAS"
    assert p.parent.parent.parent.name.startswith("BOLITOS CONFEITARIA")
    assert p.is_file() and not src.exists()
    # não é um ZIP do mês: fica fora das renomeações e da tela Downloads
    assert not is_note_file(p.name)
    assert AVULSA_FILE.match(p.name)["key"] == KEY
    # a mesma nota de novo (conteúdo igual): reaproveita o arquivo
    src.write_bytes(nfe_zip(KEY))
    again = org.store(src, "CLI000036", "2026-08", DocumentType.NFE_RECEBIDAS, "BOLITOS CONFEITARIA", note_key=KEY)
    assert again.filepath == stored.filepath
    # conteúdo diferente com a mesma chave: versão (2)
    other = tmp_path / "b.zip"
    with zipfile.ZipFile(other, "w") as z:
        z.writestr(f"{KEY}.xml", "<nfeProc/>")
    second = org.store(other, "CLI000036", "2026-08", DocumentType.NFE_RECEBIDAS, "BOLITOS CONFEITARIA", note_key=KEY)
    assert Path(second.filepath).name == avulsa_filename(KEY, "CLI000036", sequence=2)
    # plano B: o nome avulso guardado (keep_name) volta para a pasta Avulsas
    src.write_bytes(nfe_zip(KEY))
    kept = org.store(src, "CLI000036", "2026-09", DocumentType.NFE_RECEBIDAS, "BOLITOS", keep_name=f"NFe {KEY} - CLI000036.zip")
    assert Path(kept.filepath).parent.name == "Avulsas"


# -- scheduler: o arquivo vem no clique --------------------------------------------


def _key_job(repo: FakeRepo, **kw):  # noqa: ANN003, ANN202
    client = make_client()
    repo.add_client(client, make_certificate(client))
    return client, repo.add_job(client, [TaskType.NFE_KEY_EXPORT], note_key=KEY, **kw)


def _direct(settings: Settings, payload: bytes):  # noqa: ANN202
    """schedule() do FakeProvider que, como o SIAT real, devolve o arquivo da nota no clique."""

    async def schedule(ctx, task):  # noqa: ANN001, ANN202
        tmp = settings.downloads_dir.parent / f"tmp_{task.id}.zip"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(payload)
        from app.downloads.organizer import EmptyExportError

        try:
            stored = ctx.organizer.store(tmp, ctx.client.client_code, ctx.job.competence, task.document_type, note_key=ctx.job.note_key)
        except EmptyExportError:
            return ExportRequestResult(document_type=task.document_type, requested_at=datetime.now(timezone.utc), no_notes=True)
        return ExportRequestResult(document_type=task.document_type, requested_at=datetime.now(timezone.utc), downloaded=stored)

    return schedule


async def test_scheduler_completes_key_job_when_siat_hands_the_file_at_once(
    repo: FakeRepo, provider: FakeProvider, deps, settings: Settings  # noqa: ANN001
) -> None:
    _, job = _key_job(repo)
    provider.schedule = _direct(settings, nfe_zip(KEY))  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "Nota exportada do SIAT e disponível na tela Notas"
    assert len(repo.downloads) == 1
    d = repo.downloads[0]
    assert d["note_key"] == KEY and d["document_type"] == "NFE_RECEBIDAS"
    assert Path(d["filepath"]).parent.name == "Avulsas"
    # indexada na hora: a tela Notas já encontra a chave
    notes = repo._notes()
    assert [n["chave"] for n in notes] == [KEY]
    assert notes[0]["numero"] == 172280 and notes[0]["emit_nome"] == "SENDAS DISTRIBUIDORA S/A"
    assert d.get("notes_indexed_at") and d.get("note_count") == 1
    types = [t["task_type"] for t in repo.tasks_of(job.id)]
    assert types.count(TaskType.DOWNLOAD) == 1
    export = next(t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.NFE_KEY_EXPORT)
    assert TaskStatus(export["status"]) == TaskStatus.COMPLETED
    assert export["result"]["downloaded"]["filename"] == f"NFe {KEY} - CLI000001.zip"


async def test_scheduler_key_job_empty_zip_means_not_found(
    repo: FakeRepo, provider: FakeProvider, deps, settings: Settings  # noqa: ANN001
) -> None:
    _, job = _key_job(repo)
    provider.schedule = _direct(settings, EMPTY_ZIP)  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "Nota não encontrada no SIAT com o certificado desta empresa"
    assert repo.downloads == [] and repo._notes() == []


# -- collector: caso o SIAT agende em vez de entregar --------------------------------


async def test_collector_saves_key_download_and_indexes_it_now(
    repo: FakeRepo, provider: FakeProvider, deps, settings: Settings  # noqa: ANN001
) -> None:
    _, job = _key_job(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
    provider.statuses = {DocumentType.NFE_RECEBIDAS: ExportStatus.PROCESSED}

    async def download(ctx, task, status):  # noqa: ANN001, ANN202
        tmp = settings.downloads_dir.parent / f"tmp_{task.id}.zip"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(nfe_zip(KEY))
        return ctx.organizer.store(tmp, ctx.client.client_code, ctx.job.competence, task.document_type, note_key=ctx.job.note_key)

    provider.download = download  # type: ignore[method-assign]
    assert await CollectorRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "Nota exportada do SIAT e disponível na tela Notas"
    d = repo.downloads[0]
    assert d["note_key"] == KEY and Path(d["filepath"]).parent.name == "Avulsas"
    assert [n["chave"] for n in repo._notes()] == [KEY]


async def test_collector_key_not_found_says_so(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _key_job(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
    provider.statuses = {DocumentType.NFE_RECEBIDAS: ExportStatus.EMPTY}
    assert await CollectorRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed"
    assert j["last_message"] == "Nota não encontrada no SIAT com o certificado desta empresa"
    assert repo.downloads == []


async def test_collector_rechecks_key_job_sooner(repo: FakeRepo, provider: FakeProvider, deps) -> None:  # noqa: ANN001
    _, job = _key_job(repo, status="waiting_sefaz", task_status=TaskStatus.SCHEDULED)
    provider.statuses = {DocumentType.NFE_RECEBIDAS: ExportStatus.PROCESSING}
    await CollectorRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "waiting_sefaz"
    assert j["next_check_at"] <= datetime.now(timezone.utc) + timedelta(minutes=2, seconds=5)


# -- SIAT simulado -------------------------------------------------------------


@pytest.mark.integration
async def test_siat_hands_the_note_file_on_export_click(repo: FakeRepo, integration_settings: Settings) -> None:
    """Radio da chave -> Chave NFE (DANFE) -> Exportar: o ZIP vem no clique e vai para .../Avulsas;
    nenhuma linha nova na lista, nenhum agendamento. A guarda de segurança não confunde o filtro
    "IE" do cabeçalho da lista com o campo Inscrição (bug visto no SIAT real em 06/10/2026)."""
    state = MockState()
    ctx, job = await _context(repo, integration_settings, operations=[TaskType.NFE_KEY_EXPORT], note_key=KEY)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        tasks = await repo.list_tasks(job.id)
        assert [t.task_type for t in tasks] == [TaskType.NFE_KEY_EXPORT]
        result = await provider.schedule(ctx, tasks[0])
    assert state.key_exports == [KEY] and state.scheduled == []
    assert result.downloaded is not None and not result.no_notes and result.external_request_id is None
    path = Path(result.downloaded.filepath)
    assert path.name == f"NFe {KEY} - CLI000001.zip"
    assert path.parent.name == "Avulsas" and path.parent.parent.name == "NFE_RECEBIDAS"
    assert path.is_file()
    notes = index_zip(path)
    assert notes and notes[0].chave == KEY and notes[0].numero == 172280


@pytest.mark.integration
async def test_siat_empty_zip_on_key_export_means_not_found(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState(key_empty=True)
    ctx, job = await _context(repo, integration_settings, operations=[TaskType.NFE_KEY_EXPORT], note_key=KEY)
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        tasks = await repo.list_tasks(job.id)
        result = await provider.schedule(ctx, tasks[0])
    assert result.no_notes and result.downloaded is None
    assert state.key_exports == [KEY]
    assert not list((integration_settings.downloads_dir).rglob("Avulsas/*"))


@pytest.mark.integration
async def test_siat_key_form_rejects_bad_key(repo: FakeRepo, integration_settings: Settings) -> None:
    state = MockState()
    ctx, job = await _context(repo, integration_settings, operations=[TaskType.NFE_KEY_EXPORT], note_key="1234")
    provider = SiatAutomationProvider()
    async with provider.open_session(ctx):
        await _open(provider, ctx, state)
        tasks = await repo.list_tasks(job.id)
        with pytest.raises(AutomationError) as exc:
            await provider.schedule(ctx, tasks[0])
        assert exc.value.code == ErrorCode.SCHEDULE_FAILED
        assert state.key_exports == [] and state.scheduled == []
