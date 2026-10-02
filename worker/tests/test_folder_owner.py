"""Um escritório por pasta das notas (mesma conta do Google para mais de um escritório)."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from app.config import Settings
from app.downloads.fallback import FallbackOrganizer
from app.downloads.folder_owner import (
    MARKER,
    Office,
    OwnerUnreadable,
    claim_or_check,
    load_office,
    read_owner,
    save_office,
    write_owner,
)
from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer
from app.tools import google_drive as gd
from fakes import FakeRepo

A = Office("aaaaaaaa-0000-0000-0000-000000000001", "Escritório Jhon")
B = Office("bbbbbbbb-0000-0000-0000-000000000002", "Contabilidade Silva")


def _zip(path: Path) -> Path:
    import zipfile

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("1.xml", "<nfeProc/>")
    return path


def test_first_office_marks_the_folder_others_are_refused(tmp_path: Path) -> None:
    folder = tmp_path / "JR Sistema - Notas"
    folder.mkdir()
    assert claim_or_check(folder, A, "DESKTOP-74B4DAU") is None  # sem dono: marca
    assert read_owner(folder) == A
    assert claim_or_check(folder, A) is None  # o mesmo escritório (outro PC dele também)
    assert claim_or_check(folder, B) == A  # outro escritório: recusado
    assert read_owner(folder) == A  # e a marca não muda
    (folder / MARKER).write_text("{quebrado", encoding="utf-8")
    with pytest.raises(OwnerUnreadable):
        claim_or_check(folder, A)


def test_office_cache(tmp_path: Path) -> None:
    path = tmp_path / "escritorio.json"
    assert load_office(path) is None
    save_office(path, B)
    assert load_office(path) == B


def test_notes_of_another_office_go_to_plan_b(tmp_path: Path) -> None:
    """PC do escritório B apontado (por engano) para a pasta do escritório A: não grava lá."""
    drive, local = tmp_path / "drive", tmp_path / "local"
    drive.mkdir()
    write_owner(drive, A)
    org = FallbackOrganizer(drive, local, tmp_path / "pendentes.json")
    org.office = B
    stored = org.store(_zip(tmp_path / "tmp" / "a.zip"), "CLI000001", "2026-09", "NFCE", client_name="LOJA B")
    assert stored.saved_locally
    assert Path(stored.filepath).is_relative_to(local)
    assert org.foreign_owner == A
    assert [p.name for p in drive.iterdir()] == [MARKER]  # nada gravado na pasta do outro escritório
    assert org.reorganize() == 0 and org.send_pending() == 0  # nem mexe nela


def test_own_office_stores_and_marks(tmp_path: Path) -> None:
    drive = tmp_path / "drive"
    org = DownloadOrganizer(drive)
    org.office = A
    stored = org.store(_zip(tmp_path / "tmp" / "a.zip"), "CLI000001", "2026-09", "NFCE", client_name="LIA")
    assert not stored.saved_locally and Path(stored.filepath).is_relative_to(drive)
    assert read_owner(drive) == A
    assert org.foreign_owner is None


def test_old_installation_without_office_does_not_mark(tmp_path: Path) -> None:
    drive = tmp_path / "drive"
    org = DownloadOrganizer(drive)  # instalação antiga (chave-mestra): não sabe o escritório
    org.store(_zip(tmp_path / "tmp" / "a.zip"), "CLI000001", "2026-09", "NFCE", client_name="LIA")
    assert not (drive / MARKER).exists()


async def test_worker_knows_its_office_and_skips_a_foreign_folder(
    settings: Settings, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import app.worker as w

    s = settings.model_copy(update={"download_base_path": str(tmp_path / "drive")})
    (tmp_path / "drive").mkdir()
    write_owner(tmp_path / "drive", A)
    repo = FakeRepo()
    repo.office = B
    worker = w.Worker(repo, s, worker_id="teste")  # type: ignore[arg-type]
    await worker._resolve_office()
    assert worker.organizer.office == B
    assert load_office(s.office_file) == B  # guardado para usar sem internet e na ferramenta
    with caplog.at_level(logging.ERROR):
        assert worker._notes_folder_ready() is False
        assert worker._notes_folder_ready() is False
    assert sum("é do escritório" in r.getMessage() for r in caplog.records) == 1  # avisa uma vez só


async def test_worker_without_internet_uses_the_saved_office(settings: Settings, tmp_path: Path) -> None:
    import app.worker as w

    save_office(settings.office_file, A)

    class Offline(FakeRepo):
        async def device_org(self):  # noqa: ANN201
            raise ConnectionError("sem internet")

    worker = w.Worker(Offline(), settings, worker_id="teste")  # type: ignore[arg-type]
    await worker._resolve_office()
    assert worker.organizer.office == A


def test_tool_picks_this_office_folder_on_a_shared_account(tmp_path: Path) -> None:
    root = tmp_path / "Meu Drive"
    plain = root / gd.NOTES_FOLDER
    # conta ainda sem a pasta: o primeiro escritório usa "JR Sistema - Notas"
    assert gd.office_folder(root, B) == (plain, None)
    plain.mkdir(parents=True)
    write_owner(plain, A)
    assert gd.office_folder(root, A) == (plain, None)
    assert gd.office_folder(root, B) == (root / "JR Sistema - Notas - Contabilidade Silva", A)
    assert gd.office_folder(root, None) == (plain, None)  # instalação antiga: como antes


def test_tool_run_on_a_shared_account(settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """PC do escritório B, na conta do Google do escritório A: cria a pasta própria, marca e não
    copia as notas da pasta do escritório A."""
    root = tmp_path / "G" / "Meu Drive"
    plain = root / gd.NOTES_FOLDER
    _zip(plain / "2026" / "08" / "LIA" / "NFCE" / "LIA - NFC-e - 08-2026 - CLI000001.zip")
    write_owner(plain, A)
    s = settings.model_copy(update={"download_base_path": str(plain)})  # apontado para a pasta de A
    save_office(s.office_file, B)
    env = tmp_path / ".env"
    env.write_text(f"DOWNLOAD_BASE_PATH='{plain.as_posix()}'\n", encoding="utf-8")
    monkeypatch.setattr(gd, "find_drive_roots", lambda: [root])
    monkeypatch.setattr(gd, "is_admin", lambda: True)
    monkeypatch.setattr(gd, "restart_and_confirm", lambda _s, _t: "ok")
    assert gd.run(s, env_file=env, ask=lambda q: "s") == 0
    own = root / "JR Sistema - Notas - Contabilidade Silva"
    assert read_owner(own) == B
    assert [p.name for p in own.iterdir()] == [MARKER]  # nada do escritório A foi copiado
    assert f"DOWNLOAD_BASE_PATH='{own.as_posix()}'" in env.read_text(encoding="utf-8")


def test_unavailable_error_explains_the_owner(tmp_path: Path) -> None:
    drive = tmp_path / "drive"
    drive.mkdir()
    write_owner(drive, A)
    org = DownloadOrganizer(drive)
    org.office = B
    with pytest.raises(DownloadFolderUnavailable, match="Escritório Jhon"):
        org.check_available()
