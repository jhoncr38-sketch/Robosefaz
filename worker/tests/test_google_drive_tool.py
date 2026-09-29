"""Ferramenta "Salvar notas no Google Drive" (menu Iniciar)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.tools import google_drive as gd

# formato antigo (até a 1.2.7) e atual: a cópia já grava em ano/mês/cliente
NOTE = Path("CLI000001 - LIA") / "2026" / "08" / "NFCE" / "CLI000001_2026-08_NFCE.zip"
NEW = Path("2026") / "08" / "CLI000001 - LIA" / "NFCE" / "CLI000001_2026-08_NFCE.zip"


def test_find_drive_roots(tmp_path: Path) -> None:
    g, d, home = tmp_path / "G", tmp_path / "D", tmp_path / "home"
    (g / "Meu Drive").mkdir(parents=True)
    d.mkdir()
    (home / "My Drive").mkdir(parents=True)  # modo "Espelhar arquivos"
    assert gd.find_drive_roots([d, g], home) == [g / "Meu Drive", home / "My Drive"]
    assert gd.find_drive_roots([d], tmp_path / "vazio") == []


def test_env_value() -> None:
    assert gd.env_value(Path(r"G:\Meu Drive\JR Sistema - Notas")) == "'G:/Meu Drive/JR Sistema - Notas'"
    assert gd.env_value("./storage/downloads") == "'./storage/downloads'"
    with pytest.raises(ValueError):
        gd.env_value("G:/D'Avila")


def test_env_value_is_read_back_by_settings(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("SUPABASE_URL=https://x.supabase.co\nDOWNLOAD_BASE_PATH=./storage/downloads\n", encoding="utf-8")
    gd.set_download_path(env, gd.env_value(Path(r"G:\Meu Drive\JR Sistema - Notas")))
    s = Settings(_env_file=env)
    assert s.downloads_dir == Path(r"G:\Meu Drive\JR Sistema - Notas")
    assert s.supabase_url == "https://x.supabase.co"  # o resto do .env fica igual


def test_copy_notes_never_overwrites(tmp_path: Path) -> None:
    src, dst = tmp_path / "local", tmp_path / "drive"
    for rel, data in ((NOTE, b"PK1"), (NOTE.with_name("CLI000001_2026-08_NFCE_2.zip"), b"PK2")):
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_bytes(data)
    (src / "desktop.ini").write_text("x", encoding="utf-8")  # só notas são copiadas
    (dst / NEW).parent.mkdir(parents=True)
    (dst / NEW).write_bytes(b"ja estava")
    assert gd.copy_notes(src, dst) == (1, 1)
    assert (dst / NEW).read_bytes() == b"ja estava"
    assert (dst / NEW.with_name("CLI000001_2026-08_NFCE_2.zip")).read_bytes() == b"PK2"
    assert not (dst / "desktop.ini").exists()
    assert gd.copy_notes(src, src) == (0, 0)


@pytest.fixture
def setup(settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    env = tmp_path / ".env"
    env.write_text(f"DEVICE_EMAIL=robo@x\nDOWNLOAD_BASE_PATH='{settings.downloads_dir.as_posix()}'\n", encoding="utf-8")
    (settings.downloads_dir / NOTE).parent.mkdir(parents=True)
    (settings.downloads_dir / NOTE).write_bytes(b"PK")
    root = tmp_path / "G" / "Meu Drive"
    root.mkdir(parents=True)
    monkeypatch.setattr(gd, "find_drive_roots", lambda: [root])
    monkeypatch.setattr(gd, "is_admin", lambda: True)
    return env, root / gd.NOTES_FOLDER


def test_run_switches_to_drive(settings: Settings, setup, monkeypatch: pytest.MonkeyPatch) -> None:
    env, target = setup
    target.mkdir()
    monkeypatch.setattr(gd, "restart_and_confirm", lambda s, t: "ok")
    assert gd.run(settings, env_file=env, ask=lambda q: "") == 0
    assert (target / NEW).read_bytes() == b"PK"
    assert (settings.downloads_dir / NOTE).is_file()  # original fica
    assert f"DOWNLOAD_BASE_PATH='{target.as_posix()}'" in env.read_text(encoding="utf-8")
    assert "DEVICE_EMAIL=robo@x" in env.read_text(encoding="utf-8")


def test_run_asks_before_creating_folder(settings: Settings, setup, monkeypatch: pytest.MonkeyPatch) -> None:
    env, target = setup
    before = env.read_text(encoding="utf-8")
    assert gd.run(settings, env_file=env, ask=lambda q: "n") == 1
    assert not target.exists() and env.read_text(encoding="utf-8") == before
    monkeypatch.setattr(gd, "restart_and_confirm", lambda s, t: "stopped")
    assert gd.run(settings, env_file=env, ask=lambda q: "s") == 0
    assert target.is_dir()


def test_run_reverts_when_robot_cannot_see_the_drive(settings: Settings, setup, monkeypatch: pytest.MonkeyPatch) -> None:
    env, target = setup
    target.mkdir()
    before = env.read_text(encoding="utf-8")
    monkeypatch.setattr(gd, "restart_and_confirm", lambda s, t: "unavailable")
    assert gd.run(settings, env_file=env, ask=lambda q: "") == 1
    assert env.read_text(encoding="utf-8") == before
    assert settings.update_flag.exists()  # religa o robô com a pasta antiga


def test_run_does_nothing_when_write_fails(settings: Settings, setup, monkeypatch: pytest.MonkeyPatch) -> None:
    env, target = setup
    target.mkdir()
    before = env.read_text(encoding="utf-8")

    def denied(folder: Path) -> None:
        raise PermissionError("Acesso negado")

    monkeypatch.setattr(gd, "probe_write", denied)
    assert gd.run(settings, env_file=env, ask=lambda q: "") == 1
    assert env.read_text(encoding="utf-8") == before
    assert not (target / NEW).exists() and not (target / NOTE).exists()


def test_run_without_drive(settings: Settings, setup, monkeypatch: pytest.MonkeyPatch) -> None:
    env, _ = setup
    monkeypatch.setattr(gd, "find_drive_roots", lambda: [])
    monkeypatch.setattr(gd, "drive_app_running", lambda: False)
    assert gd.run(settings, env_file=env, ask=lambda q: "") == 1


def test_restart_reads_robot_log(settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log = tmp_path / "worker.log"
    log.write_text("linha antiga: Downloads serão salvos em C:\\velha\n", encoding="utf-8")
    s = settings.model_copy(update={"log_file_path": str(log)})
    target = tmp_path / "G" / "Meu Drive" / gd.NOTES_FOLDER
    monkeypatch.setattr("app.tray.read_local_status", lambda path: ("idle", False))

    def fake_sleep(_: float) -> None:
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"2026-09-29 INFO worker: Downloads serão salvos em {target}\n")

    monkeypatch.setattr(gd.time, "sleep", fake_sleep)
    assert gd.restart_and_confirm(s, target, timeout=5) == "ok"
    assert s.update_flag.exists()
    monkeypatch.setattr("app.tray.read_local_status", lambda path: ("stopped", False))
    assert gd.restart_and_confirm(s, target) == "stopped"
