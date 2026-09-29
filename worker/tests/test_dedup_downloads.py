"""Controle de duplicidade e estrutura de pastas/arquivos de download."""

from pathlib import Path

import pytest

from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer
from app.jobs.dedup import DuplicateGuard, build_dedup_key, conflicts, is_duplicate
from app.jobs.models import DocumentType, Task, TaskStatus, TaskType
from app.utils.files import sha256_file
from fakes import FakeRepo, make_client


def _task(status: TaskStatus, key: str = "k", superseded: bool = False, tid: str = "t1") -> Task:
    return Task(
        id=tid,
        job_id="j",
        client_id="c",
        task_type=TaskType.NFCE_EXPORT,
        status=status,
        competence="2026-08",
        document_type=DocumentType.NFCE,
        dedup_key=key,
        superseded=superseded,
    )


class TestDedup:
    def test_key_format(self) -> None:
        assert build_dedup_key("c1", "2026-08", DocumentType.NFE_EMITIDAS) == "c1|2026-08|NFE_EMITIDAS|EXPORT"
        assert build_dedup_key("c1", "2026-08", "NFCE", "EXPORT") == "c1|2026-08|NFCE|EXPORT"

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (TaskStatus.SCHEDULED, True),
            (TaskStatus.PROCESSED, True),
            (TaskStatus.COMPLETED, True),
            (TaskStatus.PENDING, False),
            (TaskStatus.FAILED, False),
            (TaskStatus.CANCELLED, False),
        ],
    )
    def test_is_duplicate(self, status: TaskStatus, expected: bool) -> None:
        assert is_duplicate(_task(status)) is expected

    def test_force_and_superseded(self) -> None:
        assert not is_duplicate(_task(TaskStatus.SCHEDULED), force=True)
        assert not is_duplicate(_task(TaskStatus.SCHEDULED, superseded=True))
        assert not is_duplicate(None)

    def test_conflicts(self) -> None:
        tasks = [
            _task(TaskStatus.SCHEDULED, "a", tid="1"),
            _task(TaskStatus.FAILED, "a", tid="2"),
            _task(TaskStatus.SCHEDULED, "b", tid="3"),
            _task(TaskStatus.SCHEDULED, "a", superseded=True, tid="4"),
        ]
        assert [t.id for t in conflicts(tasks, "a")] == ["1"]

    async def test_guard_detects_scheduled_in_other_job(self) -> None:
        repo = FakeRepo()
        client = make_client()
        repo.add_client(client)
        old = repo.add_job(client, [TaskType.NFCE_EXPORT], task_status=TaskStatus.SCHEDULED)
        new = repo.add_job(client, [TaskType.NFCE_EXPORT])
        new_task = (await repo.list_tasks(new.id))[0]
        found = await DuplicateGuard(repo).already_scheduled(new_task)
        assert found is not None and found.job_id == old.id
        assert await DuplicateGuard(repo).already_scheduled(new_task, force=True) is None


class TestDownloadOrganizer:
    def test_folder_and_filename(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path)
        folder = org.folder_for("CLI000001", "2026-08", DocumentType.NFCE)
        assert folder == (tmp_path / "2026" / "08" / "CLI000001" / "NFCE").resolve()
        assert org.filename_for("CLI000001", "2026-08", DocumentType.NFCE) == "CLI000001_2026-08_NFCE.zip"
        assert org.filename_for("CLI000001", "08/2026", "NFE_EMITIDAS") == "CLI000001_2026-08_NFE_EMITIDAS.zip"
        assert org.filename_for("CLI000001", "2026-08", "NFE_RECEBIDAS") == "CLI000001_2026-08_NFE_RECEBIDAS.zip"

    def test_rejects_path_traversal(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path)
        with pytest.raises(ValueError):
            org.folder_for("../x", "2026-08", DocumentType.NFCE)

    def test_store_moves_hashes_and_dedupes(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path / "downloads")
        src = tmp_path / "a.zip"
        src.write_bytes(b"zip-1")
        expected_hash = sha256_file(src)
        stored = org.store(src, "CLI000001", "2026-08", DocumentType.NFE_EMITIDAS)
        assert stored.filename == "CLI000001_2026-08_NFE_EMITIDAS.zip"
        assert stored.checksum == expected_hash and len(stored.checksum) == 64
        assert Path(stored.filepath).read_bytes() == b"zip-1"
        assert not src.exists()

        # mesmo conteúdo -> não duplica
        again = tmp_path / "b.zip"
        again.write_bytes(b"zip-1")
        same = org.store(again, "CLI000001", "2026-08", DocumentType.NFE_EMITIDAS)
        assert same.filepath == stored.filepath

        # conteúdo diferente -> sufixo _2
        other = tmp_path / "c.zip"
        other.write_bytes(b"zip-2")
        second = org.store(other, "CLI000001", "2026-08", DocumentType.NFE_EMITIDAS)
        assert second.filename == "CLI000001_2026-08_NFE_EMITIDAS_2.zip"


class TestDownloadFolder:
    """Pasta de downloads no Google Drive: unidade ausente e arquivo gravado por outro computador."""

    def test_missing_drive_is_reported(self, tmp_path: Path) -> None:
        missing = next((Path(f"{d}:/SIAT") for d in "QRSTUVWXYZ" if not Path(f"{d}:/").exists()), None)
        if missing is None:
            pytest.skip("todas as letras de unidade em uso")
        org = DownloadOrganizer(missing)
        with pytest.raises(DownloadFolderUnavailable):
            org.check_available()
        src = tmp_path / "a.zip"
        src.write_bytes(b"PK\x03\x04zip")
        with pytest.raises(DownloadFolderUnavailable):
            org.store(src, "CLI000001", "2026-08", DocumentType.NFCE)
        assert src.exists()  # arquivo temporário preservado até a próxima tentativa

    def test_locate_uses_stored_path_on_same_machine(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path / "downloads")
        src = tmp_path / "a.zip"
        src.write_bytes(b"zip-1")
        stored = org.store(src, "CLI000001", "2026-08", DocumentType.NFCE)
        found = org.locate(stored.filepath, "CLI000001", "2026-08", "NFCE", stored.filename)
        assert found == Path(stored.filepath).resolve()

    def test_locate_from_other_machine_path(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path / "downloads")
        src = tmp_path / "a.zip"
        src.write_bytes(b"zip-1")
        stored = org.store(src, "CLI000001", "2026-08", DocumentType.NFCE)
        other = "G:/Meu Drive/SIAT-Notas/CLI000001/2026/08/NFCE/CLI000001_2026-08_NFCE.zip"
        found = org.locate(other, "CLI000001", "2026-08", "NFCE", stored.filename)
        assert found == Path(stored.filepath).resolve()

    def test_locate_rejects_traversal_in_filename(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path / "downloads")
        with pytest.raises(ValueError):
            org.locate("x", "CLI000001", "2026-08", "NFCE", "../../segredo.txt")


class TestContentSniffing:
    def test_zip_gets_zip_extension_even_with_wrong_name(self, tmp_path: Path) -> None:
        src = tmp_path / "export.htm"
        src.write_bytes(b"PK\x03\x04 dados")
        stored = DownloadOrganizer(tmp_path / "d").store(src, "CLI000001", "2026-08", DocumentType.NFCE)
        assert stored.filename == "CLI000001_2026-08_NFCE.zip"

    def test_xml_extension(self, tmp_path: Path) -> None:
        src = tmp_path / "x.bin"
        src.write_bytes(b'<?xml version="1.0"?><nfeProc/>')
        stored = DownloadOrganizer(tmp_path / "d").store(src, "CLI000001", "2026-08", DocumentType.NFCE)
        assert stored.filename.endswith(".xml")

    def test_html_error_page_is_rejected(self, tmp_path: Path) -> None:
        from app.downloads.organizer import InvalidDownloadError

        src = tmp_path / "e.zip"
        src.write_bytes(b"<!DOCTYPE html><html><body>Sessao expirada</body></html>")
        with pytest.raises(InvalidDownloadError):
            DownloadOrganizer(tmp_path / "d").store(src, "CLI000001", "2026-08", DocumentType.NFCE)


class TestClientFolderName:
    """Pasta do cliente com o nome da empresa: 'CLI000001 - LIA PAPELARIA'."""

    def test_store_uses_code_and_name(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path)
        src = tmp_path / "a.zip"
        src.write_bytes(b"PK\x03\x04a")
        stored = org.store(src, "CLI000001", "2026-06", DocumentType.NFCE, client_name="LIA PAPELARIA & VARIEDADE")
        assert Path(stored.filepath).relative_to(tmp_path).parts == (
            "2026", "06", "CLI000001 - LIA PAPELARIA & VARIEDADE", "NFCE", "CLI000001_2026-06_NFCE.zip"
        )

    def test_old_code_only_folder_is_renamed_with_its_files(self, tmp_path: Path) -> None:
        month = tmp_path / "2026" / "08"
        (month / "CLI000002" / "NFCE").mkdir(parents=True)
        (month / "CLI000002" / "NFCE" / "CLI000002_2026-08_NFCE.zip").write_bytes(b"PK\x03\x04old")
        org = DownloadOrganizer(tmp_path)
        assert org.sync_client_dir("CLI000002", "SELETO PLANEJADOS") == [month / "CLI000002 - SELETO PLANEJADOS"]
        assert not (month / "CLI000002").exists()
        assert (month / "CLI000002 - SELETO PLANEJADOS" / "NFCE" / "CLI000002_2026-08_NFCE.zip").is_file()

    def test_name_change_renames_and_old_paths_still_found(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path)
        src = tmp_path / "a.zip"
        src.write_bytes(b"PK\x03\x04a")
        stored = org.store(src, "CLI000001", "2026-06", DocumentType.NFCE, client_name="NOME ANTIGO")
        assert org.sync_client_names({"CLI000001": "NOME NOVO", "CLI000009": "OUTRO"}) == 1
        assert [d.name for d in (tmp_path / "2026" / "06").iterdir()] == ["CLI000001 - NOME NOVO"]
        # caminho gravado no banco ficou velho: ainda acha pela pasta do código
        found = org.locate(stored.filepath, "CLI000001", "2026-06", "NFCE", stored.filename)
        assert found.is_file() and "NOME NOVO" in str(found)

    def test_no_folder_is_created_when_client_has_no_notes(self, tmp_path: Path) -> None:
        assert DownloadOrganizer(tmp_path).sync_client_dir("CLI000009", "SEM NOTAS") == []
        assert list(tmp_path.iterdir()) == []


def test_empty_zip_is_not_stored(tmp_path) -> None:  # noqa: ANN001
    import zipfile

    import pytest

    from app.downloads.organizer import DownloadOrganizer, EmptyExportError

    src = tmp_path / "vazio.zip"
    zipfile.ZipFile(src, "w").close()  # 22 bytes: só o fim do índice
    assert src.stat().st_size == 22
    org = DownloadOrganizer(tmp_path / "downloads")
    with pytest.raises(EmptyExportError):
        org.store(src, "CLI000022", "2026-09", "NFE_EMITIDAS", "BOLO DO EDU")
    assert not (tmp_path / "downloads").exists() or not any((tmp_path / "downloads").rglob("*.zip"))


class TestMonthFirst:
    """Pastas ano/mês/cliente/tipo (desde a 1.2.8) e a mudança do formato antigo."""

    def test_parse_note_path_both_layouts(self) -> None:
        from app.downloads.organizer import parse_note_path

        new = parse_note_path(("2026", "08", "CLI000001 - LIA", "NFCE", "CLI000001_2026-08_NFCE.zip"))
        old = parse_note_path(("CLI000001 - LIA", "2026", "08", "NFCE", "CLI000001_2026-08_NFCE.zip"))
        assert new == old and new is not None
        assert (new.client_code, new.client_name, new.competence) == ("CLI000001", "LIA", "2026-08")
        assert new.parts == ("2026", "08", "CLI000001 - LIA", "NFCE", "CLI000001_2026-08_NFCE.zip")
        assert parse_note_path(("2026", "08", "CLI000001", "NFCE", "desktop.ini")) is None
        assert parse_note_path(("2026", "13", "CLI000001", "NFCE", "CLI000001_2026-13_NFCE.zip")) is None

    def test_reorganize_moves_old_layout_only(self, tmp_path: Path) -> None:
        old = tmp_path / "CLI000001 - LIA" / "2026" / "08"
        for doc, data in (("NFCE", b"PK1"), ("NFE_EMITIDAS", b"PK2")):
            (old / doc).mkdir(parents=True)
            (old / doc / f"CLI000001_2026-08_{doc}.zip").write_bytes(data)
        (old / "NFCE" / "desktop.ini").write_text("x", encoding="utf-8")
        # já existe no lugar novo: a antiga fica (nunca apaga nota)
        new_nfe = tmp_path / "2026" / "08" / "CLI000001 - LIA" / "NFE_EMITIDAS" / "CLI000001_2026-08_NFE_EMITIDAS.zip"
        new_nfe.parent.mkdir(parents=True)
        new_nfe.write_bytes(b"ja estava")
        org = DownloadOrganizer(tmp_path)
        assert org.reorganize() == 1
        assert (tmp_path / "2026" / "08" / "CLI000001 - LIA" / "NFCE" / "CLI000001_2026-08_NFCE.zip").read_bytes() == b"PK1"
        assert new_nfe.read_bytes() == b"ja estava"
        assert (old / "NFE_EMITIDAS" / "CLI000001_2026-08_NFE_EMITIDAS.zip").read_bytes() == b"PK2"
        assert not (old / "NFCE").exists()  # vazia (só desktop.ini): removida
        assert org.reorganize() == 0

    def test_reorganize_takes_extracted_files_along(self, tmp_path: Path) -> None:
        # XMLs que alguém descompactou dentro da pasta do mês vão junto, com as subpastas
        month = tmp_path / "CLI000002 - SELETO" / "2026" / "06" / "NFCE"
        (month / "TP-1" / "PI").mkdir(parents=True)
        (month / "CLI000002_2026-06_NFCE.zip").write_bytes(b"PK")
        (month / "TP-1" / "PI" / "2226.xml").write_text("<nfe/>", encoding="utf-8")
        (tmp_path / "CLI000002 - SELETO" / "leia-me.txt").write_text("fora de ano/mês", encoding="utf-8")
        assert DownloadOrganizer(tmp_path).reorganize() == 2
        new = tmp_path / "2026" / "06" / "CLI000002 - SELETO" / "NFCE"
        assert (new / "CLI000002_2026-06_NFCE.zip").is_file()
        assert (new / "TP-1" / "PI" / "2226.xml").read_text(encoding="utf-8") == "<nfe/>"
        assert (tmp_path / "CLI000002 - SELETO" / "leia-me.txt").is_file()  # não é do robô: fica
        assert not (tmp_path / "CLI000002 - SELETO" / "2026").exists()

    def test_locate_after_reorganize(self, tmp_path: Path) -> None:
        old = tmp_path / "CLI000001 - LIA" / "2026" / "08" / "NFCE" / "CLI000001_2026-08_NFCE.zip"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"PK")
        org = DownloadOrganizer(tmp_path)
        org.reorganize()
        found = org.locate(str(old), "CLI000001", "2026-08", "NFCE", old.name)
        assert found.read_bytes() == b"PK" and found.parts[-4:-2] == ("08", "CLI000001 - LIA")
