"""Plano B da pasta das notas: Google Drive fora do ar -> pasta local -> envio quando voltar."""

from __future__ import annotations

from pathlib import Path

from app.config import Settings
from app.downloads.fallback import FallbackOrganizer, add_pending, organizer_for, read_pending, remove_pending
from app.downloads.organizer import DownloadOrganizer

ZIP = b"PK\x03\x04" + b"notas" * 20


def _source(tmp_path: Path, name: str = "baixado.zip", data: bytes = ZIP) -> Path:
    src = tmp_path / "tmp" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(data)
    return src


def _org(tmp_path: Path) -> FallbackOrganizer:
    # "Meu Drive" ainda não existe: simula o Google Drive fechado
    return FallbackOrganizer(tmp_path / "G" / "Meu Drive" / "JR Sistema - Notas", tmp_path / "local", tmp_path / "pend.json")


def test_organizer_for_only_uses_plan_b_for_another_folder(settings: Settings, tmp_path: Path) -> None:
    assert type(organizer_for(settings)) is DownloadOrganizer
    other = settings.model_copy(update={"download_base_path": str(tmp_path / "drive" / "notas")})
    assert isinstance(organizer_for(other), FallbackOrganizer)


def test_drive_down_saves_locally_and_sends_later(tmp_path: Path) -> None:
    org = _org(tmp_path)
    stored = org.store(_source(tmp_path), "CLI000001", "2026-08", "NFCE", "LIA PAPELARIA")
    local = tmp_path / "local" / "CLI000001 - LIA PAPELARIA" / "2026" / "08" / "NFCE" / "CLI000001_2026-08_NFCE.zip"
    assert stored.saved_locally and Path(stored.filepath) == local and local.is_file()
    assert read_pending(tmp_path / "pend.json") == ["CLI000001 - LIA PAPELARIA/2026/08/NFCE/CLI000001_2026-08_NFCE.zip"]
    # ainda fora do ar: nada muda
    assert org.send_pending() == 0
    assert len(read_pending(tmp_path / "pend.json")) == 1
    # "Abrir pasta" acha a nota na pasta local enquanto ela não chegou ao Drive
    assert org.locate(stored.filepath, "CLI000001", "2026-08", "NFCE", stored.filename) == local

    org.base_dir.parent.mkdir(parents=True)  # Google Drive voltou
    assert org.send_pending() == 1
    sent = org.base_dir / "CLI000001 - LIA PAPELARIA" / "2026" / "08" / "NFCE" / "CLI000001_2026-08_NFCE.zip"
    assert sent.read_bytes() == ZIP
    assert local.is_file()  # a cópia local fica: o robô nunca apaga notas
    assert not (tmp_path / "pend.json").exists()
    assert org.locate(stored.filepath, "CLI000001", "2026-08", "NFCE", stored.filename) == sent
    assert org.send_pending() == 0


def test_drive_up_saves_directly(tmp_path: Path) -> None:
    org = _org(tmp_path)
    org.base_dir.parent.mkdir(parents=True)
    stored = org.store(_source(tmp_path), "CLI000001", "2026-08", "NFCE", "LIA")
    assert not stored.saved_locally
    assert Path(stored.filepath).is_relative_to(org.base_dir)
    assert not (tmp_path / "pend.json").exists()


def test_send_does_not_duplicate_and_forgets_deleted_files(tmp_path: Path) -> None:
    org = _org(tmp_path)
    org.store(_source(tmp_path, "a.zip"), "CLI000001", "2026-08", "NFCE", "LIA")
    gone = org.store(_source(tmp_path, "b.zip", ZIP + b"x"), "CLI000002", "2026-08", "NFCE", "SELETO")
    Path(gone.filepath).unlink()  # o usuário apagou da pasta local
    org.base_dir.parent.mkdir(parents=True)
    # a mesma nota já estava no Drive (ex.: copiada à mão): não cria _2
    same = org.base_dir / "CLI000001 - LIA" / "2026" / "08" / "NFCE" / "CLI000001_2026-08_NFCE.zip"
    same.parent.mkdir(parents=True)
    same.write_bytes(ZIP)
    assert org.send_pending() == 1
    assert sorted(p.name for p in same.parent.iterdir()) == ["CLI000001_2026-08_NFCE.zip"]
    assert not (org.base_dir / "CLI000002 - SELETO").exists()
    assert not (tmp_path / "pend.json").exists()


def test_pending_list_keeps_items_added_during_send(tmp_path: Path) -> None:
    pend = tmp_path / "pend.json"
    add_pending(pend, "a")
    add_pending(pend, "a")
    add_pending(pend, "b")
    remove_pending(pend, {"a"})
    assert read_pending(pend) == ["b"]
    pend.write_text("{quebrado", encoding="utf-8")
    assert read_pending(pend) == []
