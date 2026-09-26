"""Link siatrobo:// do painel: só aceita ID de download e só abre arquivo de nota."""

from pathlib import Path

from app.downloads.organizer import DownloadOrganizer
from app.open_link import parse_link, resolve_file

ID = "38bdf65b-5240-46dd-9733-b621cdcfc57a"


def test_parse_link() -> None:
    assert parse_link(f"siatrobo://abrir/{ID}") == ID
    assert parse_link(f"siatrobo://abrir/{ID}/") == ID
    assert parse_link(f"SIATROBO://abrir/{ID.upper()}") == ID
    for bad in (
        "siatrobo://abrir/../../Windows",
        f"siatrobo://abrir/{ID}&calc.exe",
        f"siatrobo://abrir/{ID}/../x",
        "siatrobo://executar/calc",
        "",
    ):
        assert parse_link(bad) is None


def _zip(base: Path) -> Path:
    path = base / "CLI000001" / "2026" / "06" / "NFCE" / "CLI000001_2026-06_NFCE.zip"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"PK\x03\x04")
    return path


def _row(filepath: str) -> dict:
    return {
        "filepath": filepath,
        "filename": "CLI000001_2026-06_NFCE.zip",
        "competence": "2026-06",
        "document_type": "NFCE",
        "clients": {"client_code": "CLI000001"},
    }


def test_resolve_stored_path_and_other_machine(tmp_path: Path) -> None:
    base = tmp_path / "downloads"
    zip_path = _zip(base)
    org = DownloadOrganizer(base)
    assert resolve_file(_row(str(zip_path)), org) == zip_path
    # caminho de outro computador: usa a pasta padrão desta instalação
    found = resolve_file(_row(r"D:\outra\maquina\CLI000001_2026-06_NFCE.zip"), org)
    assert found == zip_path.resolve()


def test_never_opens_non_note_files(tmp_path: Path) -> None:
    other = tmp_path / "segredo.exe"
    other.write_bytes(b"MZ")
    row = _row(str(other)) | {"filename": "segredo.exe"}
    assert resolve_file(row, DownloadOrganizer(tmp_path / "downloads")) is None


def test_missing_file_returns_none(tmp_path: Path) -> None:
    assert resolve_file(_row(str(tmp_path / "CLI000001_2026-06_NFCE.zip")), DownloadOrganizer(tmp_path)) is None
