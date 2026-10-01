"""Nome das notas com a empresa: "LOJA X - NFC-e - 08-2026 - CLI000003 (2).zip" (desde a 1.2.26)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.downloads.organizer import (
    DownloadOrganizer,
    is_note_file,
    note_code,
    note_filename,
    parse_note_name,
)
from app.jobs.models import DocumentType
from app.utils.files import sha256_file
from fakes import FakeRepo, make_client

SANTA_ZELIA = "LOJA SANTA ZELIA E SAO LUIS"


def _zip(path: Path, content: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"PK\x03\x04" + content)
    return path


class TestNames:
    def test_both_formats_are_understood(self) -> None:
        new = parse_note_name(f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003 (2).zip")
        old = parse_note_name("CLI000003_2026-08_NFCE_2.zip")
        assert new is not None and old is not None
        assert (new.client_code, new.competence, new.document_type, new.sequence, new.company) == (
            "CLI000003", "2026-08", "NFCE", 2, SANTA_ZELIA,
        )
        assert (old.client_code, old.competence, old.document_type, old.sequence, old.company) == (
            "CLI000003", "2026-08", "NFCE", 2, None,
        )
        assert note_code("LIA PAPELARIA & VARIEDADE - NF-e recebidas - 07-2026 - CLI000001.xml") == "CLI000001"
        assert not is_note_file("desktop.ini") and not is_note_file("35260812345678000190550010000012341000012345.xml")
        assert not is_note_file("LOJA - NFC-e - 13-2026 - CLI000003.zip")  # mês 13

    def test_name_is_cleaned_and_shortened_but_keeps_the_code(self) -> None:
        assert note_filename("CLI000009", "2026-08", "NFCE", company='A/B: C*D? "E"') == "A B C D E - NFC-e - 08-2026 - CLI000009.zip"
        long = note_filename("CLI000009", "2026-08", "NFE_EMITIDAS", company="X" * 120)
        assert long == "X" * 50 + " - NF-e emitidas - 08-2026 - CLI000009.zip"
        assert note_code(long) == "CLI000009"
        # sem nome conhecido: o formato antigo
        assert note_filename("CLI000002", "2026-08", "NFCE") == "CLI000002_2026-08_NFCE.zip"

    @pytest.mark.parametrize("doc", list(DocumentType))
    def test_round_trip(self, doc: DocumentType) -> None:
        name = note_filename("CLI000010", "2025-11", doc, company="METRO DISTRIBUIDORA", sequence=3, ext=".xml")
        note = parse_note_name(name)
        assert note is not None
        assert (note.client_code, note.competence, note.document_type, note.sequence, note.ext) == (
            "CLI000010", "2025-11", doc.value, 3, ".xml",
        )


class TestStore:
    def test_new_download_gets_the_company_name_and_versions(self, tmp_path: Path) -> None:
        org = DownloadOrganizer(tmp_path)
        first = org.store(_zip(tmp_path / "a.zip", b"v1"), "CLI000003", "2026-08", "NFCE", SANTA_ZELIA)
        same = org.store(_zip(tmp_path / "b.zip", b"v1"), "CLI000003", "2026-08", "NFCE", SANTA_ZELIA)
        other = org.store(_zip(tmp_path / "c.zip", b"v2"), "CLI000003", "2026-08", "NFCE", SANTA_ZELIA)
        assert first.filename == f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003.zip"
        assert same.filepath == first.filepath  # idêntica: não duplica
        assert other.filename == f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003 (2).zip"

    def test_identical_note_with_the_old_name_is_not_duplicated(self, tmp_path: Path) -> None:
        old = _zip(tmp_path / "2026" / "08" / SANTA_ZELIA / "NFCE" / "CLI000003_2026-08_NFCE.zip", b"v1")
        org = DownloadOrganizer(tmp_path)
        again = org.store(_zip(tmp_path / "a.zip", b"v1"), "CLI000003", "2026-08", "NFCE", SANTA_ZELIA)
        assert Path(again.filepath) == old

    def test_folder_is_still_found_by_the_notes_inside_after_a_name_change(self, tmp_path: Path) -> None:
        month = tmp_path / "2026" / "08"
        _zip(month / "NOME ANTIGO" / "NFCE" / "NOME ANTIGO - NFC-e - 08-2026 - CLI000004.zip", b"x")
        org = DownloadOrganizer(tmp_path)
        assert org.sync_client_dir("CLI000004", "CRISTALIZE") == [month / "CRISTALIZE"]


class TestRename:
    def _tree(self, base: Path) -> dict[str, Path]:
        month = base / "2026" / "08"
        return {
            "nota": _zip(month / SANTA_ZELIA / "NFCE" / "CLI000003_2026-08_NFCE.zip", b"1"),
            "versao": _zip(month / SANTA_ZELIA / "NFCE" / "CLI000003_2026-08_NFCE_2.zip", b"2"),
            "ini": _zip(month / SANTA_ZELIA / "NFCE" / "desktop.ini", b"ini"),
            "xml_solto": _zip(month / SANTA_ZELIA / "NFCE" / "35260812345678000190550010000012341000012345.xml", b"x"),
            "sem_nome": _zip(month / "CLI000099" / "NFE_EMITIDAS" / "CLI000099_2026-08_NFE_EMITIDAS.zip", b"9"),
            "duplicada": _zip(base / "_Duplicadas" / "2026" / "08" / "X" / "NFCE" / "CLI000003_2026-08_NFCE.zip", b"d"),
        }

    def test_dry_run_only_lists(self, tmp_path: Path) -> None:
        files = self._tree(tmp_path)
        plan = DownloadOrganizer(tmp_path).rename_notes({"CLI000003": SANTA_ZELIA}, dry_run=True)
        assert [(a.name, b.name) for a, b in plan] == [
            ("CLI000003_2026-08_NFCE.zip", f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003.zip"),
            ("CLI000003_2026-08_NFCE_2.zip", f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003 (2).zip"),
        ]
        assert all(p.is_file() for p in files.values())  # nada mudou

    def test_rename_keeps_content_and_touches_only_robot_notes(self, tmp_path: Path) -> None:
        files = self._tree(tmp_path)
        before = sha256_file(files["versao"])
        done = DownloadOrganizer(tmp_path).rename_notes({"CLI000003": SANTA_ZELIA})
        assert len(done) == 2
        assert not files["nota"].exists() and done[0][1].is_file()
        assert sha256_file(done[1][1]) == before
        for untouched in ("ini", "xml_solto", "sem_nome", "duplicada"):
            assert files[untouched].is_file(), untouched
        assert DownloadOrganizer(tmp_path).rename_notes({"CLI000003": SANTA_ZELIA}) == []  # já convertido

    def test_never_overwrites_and_respects_limit(self, tmp_path: Path) -> None:
        files = self._tree(tmp_path)
        taken = files["nota"].with_name(f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003.zip")
        taken.write_bytes(b"PK\x03\x04outro")
        done = DownloadOrganizer(tmp_path).rename_notes({"CLI000003": SANTA_ZELIA}, limit=1)
        assert [(a.name, b.name) for a, b in done] == [
            ("CLI000003_2026-08_NFCE_2.zip", f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003 (2).zip"),
        ]
        assert files["nota"].is_file() and taken.read_bytes() == b"PK\x03\x04outro"

    def test_company_name_change_renames_the_files_too(self, tmp_path: Path) -> None:
        old = _zip(tmp_path / "2026" / "08" / "CRISTALIZE" / "NFE_EMITIDAS" / "CRISTALIZE - NF-e emitidas - 08-2026 - CLI000004.zip", b"c")
        done = DownloadOrganizer(tmp_path).rename_notes({"CLI000004": "CRISTALIZE MODAS"})
        assert [b.name for _, b in done] == ["CRISTALIZE MODAS - NF-e emitidas - 08-2026 - CLI000004.zip"]
        assert not old.exists()


async def test_worker_renames_notes_and_updates_the_panel_record(settings) -> None:  # noqa: ANN001
    from app.worker import Worker

    repo = FakeRepo()
    repo.add_client(make_client(client_code="CLI000003", trade_name=SANTA_ZELIA))
    note = _zip(settings.downloads_dir / "2026" / "08" / SANTA_ZELIA / "NFCE" / "CLI000003_2026-08_NFCE.zip", b"nota")
    checksum = sha256_file(note)
    repo.downloads.append({"id": "d1", "filename": note.name, "filepath": str(note), "checksum": checksum})
    worker = Worker(repo, settings, mode="none")  # type: ignore[arg-type]
    assert await worker._rename_notes() == 1
    new = note.with_name(f"{SANTA_ZELIA} - NFC-e - 08-2026 - CLI000003.zip")
    assert new.is_file() and not note.exists()
    assert repo.downloads[0]["filename"] == new.name and repo.downloads[0]["filepath"] == str(new)
    assert await worker._rename_notes() == 0
