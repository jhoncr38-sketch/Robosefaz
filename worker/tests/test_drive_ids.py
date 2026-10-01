"""Código das notas no Google Drive (banco local do Google Drive para computador)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.downloads.drive_ids import DriveIdLookup, DriveIds, drivefs_databases, link_drive_ids
from fakes import FakeRepo

NAME = "CLI000001_2026-09_NFE_RECEBIDAS.zip"
CLOUD = "1jIOcup0tsxX4h2TCXGwS0YYtSbGRh33v"
CLIENT = "1DB4jzRLko3Xm3ZtWdC4235rCAf7v8-Xp"
MONTH = "17sSm4IpL_iXnBG2hyRVQ6Kw_YUUVaCLX"


def _drivefs(tmp_path: Path) -> Path:
    """Banco no formato do Google Drive para computador (só as colunas que o robô lê)."""
    db = tmp_path / "Google" / "DriveFS" / "115956131569606857251" / "metadata_sqlite_db"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.execute(
        "create table items (stable_id integer primary key, id text, proto blob, trashed int, is_folder int, local_title text)"
    )
    con.execute("create table stable_parents (item_stable_id int, parent_stable_id int, local_title_hash int)")

    def add(sid: int, cloud: str, title: str, parent: int | None, folder: bool = False, trashed: bool = False) -> None:
        con.execute(
            "insert into items values (?, ?, ?, ?, ?, ?)", (sid, cloud, b"\x00\xff", int(trashed), int(folder), title)
        )
        if parent is not None:
            con.execute("insert into stable_parents values (?, ?, 0)", (sid, parent))

    add(1, "0ACY7Kd4vgzauUk9PVA", "Meu Drive", None, folder=True)
    add(2, "1UN2gjMmtcDCqC2dmlOQsXylSp4xg5f4Y", "JR Sistema - Notas", 1, folder=True)
    add(3, "1thH4fp46jEKajr11bQi3G8-tRlhFsCxg", "2026", 2, folder=True)
    add(4, MONTH, "09", 3, folder=True)
    add(5, CLIENT, "CLI000001 - LIA PAPELARIA", 4, folder=True)
    add(6, "1X6JppreqOf4oCV4xkwN8ChhH6PCKg_bN", "NFE_RECEBIDAS", 5, folder=True)
    add(7, CLOUD, NAME, 6)
    # cópia com o mesmo nome em outra pasta, uma na lixeira e uma nota ainda subindo
    add(8, "1AhpGHokr3QnAskk5gdXZDgGUHpzbeJKO", NAME, 1)
    add(9, "1RdAStReRY_0MAOmALg2BmeoM5JgxYx6A", "CLI000001_2026-09_NFCE.zip", 6, trashed=True)
    add(10, "local-1898", "CLI000001_2026-09_NFE_EMITIDAS.zip", 6)
    # formato com o nome da empresa (1.2.26): o código fica no fim
    add(11, "1NovoNomeEmpresaAbcdefghijklmnopq", "LIA PAPELARIA - NF-e recebidas - 09-2026 - CLI000001 (2).zip", 6)
    con.commit()
    con.close()
    return tmp_path


def test_finds_id_by_name_and_folders(tmp_path: Path) -> None:
    lookup = DriveIdLookup(drivefs_databases(_drivefs(tmp_path)))
    assert lookup.find(NAME, "CLI000001", "2026-09", "NFE_RECEBIDAS") == DriveIds(CLOUD, CLIENT, MONTH)
    assert lookup.find(NAME, "CLI000002", "2026-09", "NFE_RECEBIDAS") is None  # outro cliente
    assert lookup.find(NAME, "CLI000001", "2026-08", "NFE_RECEBIDAS") is None  # outra competência
    assert lookup.find("CLI000001_2026-09_NFCE.zip", "CLI000001", "2026-09", "NFE_RECEBIDAS") is None  # lixeira
    assert lookup.find("CLI000001_2026-09_NFE_EMITIDAS.zip", "CLI000001", "2026-09", "NFE_RECEBIDAS") is None  # subindo
    company = "LIA PAPELARIA - NF-e recebidas - 09-2026 - CLI000001 (2).zip"
    assert lookup.find(company, "CLI000001", "2026-09", "NFE_RECEBIDAS") == DriveIds("1NovoNomeEmpresaAbcdefghijklmnopq", CLIENT, MONTH)
    assert lookup.find(company, "CLI000002", "2026-09", "NFE_RECEBIDAS") is None  # o código no fim é de outro cliente


def test_no_google_drive_installed(tmp_path: Path) -> None:
    assert drivefs_databases(tmp_path) == []
    assert DriveIdLookup([]).find(NAME, "CLI000001", "2026-09", "NFE_RECEBIDAS") is None
    broken = tmp_path / "x" / "metadata_sqlite_db"
    broken.parent.mkdir()
    broken.write_bytes(b"nao e sqlite")
    assert DriveIdLookup([broken]).find(NAME, "CLI000001", "2026-09", "NFE_RECEBIDAS") is None


@pytest.mark.asyncio
async def test_link_drive_ids_updates_only_found(tmp_path: Path) -> None:
    repo = FakeRepo()
    repo.downloads = [
        {"id": "d1", "filename": NAME, "competence": "2026-09", "document_type": "NFE_RECEBIDAS", "clients": {"client_code": "CLI000001"}},
        {"id": "d2", "filename": "CLI000001_2026-09_NFE_EMITIDAS.zip", "competence": "2026-09", "document_type": "NFE_RECEBIDAS", "clients": {"client_code": "CLI000001"}},
    ]
    lookup = DriveIdLookup(drivefs_databases(_drivefs(tmp_path)))
    assert await link_drive_ids(repo, lookup) == 1
    assert (repo.downloads[0]["drive_file_id"], repo.downloads[0]["drive_client_folder_id"]) == (CLOUD, CLIENT)
    assert repo.downloads[0]["drive_month_folder_id"] == MONTH
    assert "drive_file_id" not in repo.downloads[1]
    assert await link_drive_ids(repo, lookup) == 0  # d1 já tem; d2 ainda subindo


def test_probe_account_finds_the_account_of_the_folder(tmp_path: Path) -> None:
    from app.downloads.drive_ids import probe_account

    dbs = drivefs_databases(_drivefs(tmp_path))
    con = sqlite3.connect(dbs[0])
    con.execute("insert into items values (99, 'local-7', null, 0, 0, 'teste-conta.txt')")
    con.commit()
    con.close()
    folder = tmp_path / "notas"
    folder.mkdir()
    assert probe_account(folder, dbs, name="teste-conta.txt") == dbs[0]
    assert list(folder.iterdir()) == []  # o arquivo de teste é apagado
    assert probe_account(folder, dbs, timeout=0, name="outra-conta.txt") is None


def test_link_state_detects_account_or_folder_change(tmp_path: Path) -> None:
    from app.downloads.drive_ids import linked_account, update_link_state

    state = tmp_path / "drive-link.json"
    folder = Path(r"G:\Meu Drive\JR Sistema - Notas")
    assert update_link_state(state, folder, "conta-pessoal") is False  # 1ª vez: só grava
    assert update_link_state(state, folder, "conta-pessoal") is False
    assert linked_account(state) == "conta-pessoal"
    assert update_link_state(state, folder, "conta-escritorio") is True  # mesma pasta, outra conta
    assert update_link_state(state, Path(r"H:\Meu Drive\JR Sistema - Notas"), "conta-escritorio") is True


async def test_worker_relinks_when_the_drive_account_changes(tmp_path: Path, settings, monkeypatch) -> None:  # noqa: ANN001
    import app.worker as w

    s = settings.model_copy(update={"download_base_path": str(tmp_path / "G" / "Meu Drive" / "JR Sistema - Notas")})
    repo = FakeRepo()
    repo.downloads = [{"id": "d1", "drive_file_id": CLOUD, "drive_client_folder_id": CLIENT, "drive_month_folder_id": MONTH}]
    monkeypatch.setattr(w, "drivefs_databases", lambda: [])
    for account, cleared in (("conta-pessoal", False), ("conta-pessoal", False), ("conta-escritorio", True)):
        db = tmp_path / "DriveFS" / account / "metadata_sqlite_db"
        monkeypatch.setattr(w, "probe_account", lambda folder, dbs, _db=db: _db)
        worker = w.Worker(repo, s, worker_id="teste")  # type: ignore[arg-type]
        assert await worker._drive_account() == db
        assert (repo.downloads[0]["drive_file_id"] is None) is cleared
