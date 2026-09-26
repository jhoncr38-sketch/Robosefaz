"""Ícone da bandeja: estado do robô a partir do arquivo local e cores."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.tray import TrayState, read_local_status
from app.tray_icons import draw, save_ico

NOW = datetime(2026, 9, 25, 20, 0, tzinfo=timezone.utc)


def _status(tmp_path: Path, status: str, age_s: float, dry_run: bool = False) -> Path:
    path = tmp_path / "worker-status.json"
    updated = (NOW - timedelta(seconds=age_s)).isoformat()
    path.write_text(json.dumps({"status": status, "updated_at": updated, "dry_run": dry_run}), encoding="utf-8")
    return path


def test_running_states(tmp_path: Path) -> None:
    assert read_local_status(_status(tmp_path, "idle", 3), NOW) == ("idle", False)
    assert read_local_status(_status(tmp_path, "busy", 3, True), NOW) == ("busy", True)


def test_stale_or_missing_file_means_stopped(tmp_path: Path) -> None:
    assert read_local_status(_status(tmp_path, "idle", 120), NOW)[0] == "stopped"  # robô fechado à força
    assert read_local_status(_status(tmp_path, "stopped", 1), NOW)[0] == "stopped"
    assert read_local_status(tmp_path / "nao-existe.json", NOW)[0] == "stopped"
    (tmp_path / "ruim.json").write_text("{", encoding="utf-8")
    assert read_local_status(tmp_path / "ruim.json", NOW)[0] == "stopped"


def test_colors_and_text() -> None:
    assert TrayState("idle").color == "idle"
    assert TrayState("busy").color == "busy"
    assert TrayState("idle", ["SELETO 08/2026: falhou"]).color == "attention"
    # parado sempre cinza, mesmo com pendências
    assert TrayState("stopped", ["x"]).color == "stopped"
    assert "modo de teste" in TrayState("idle", dry_run=True).text
    assert "1 precisa(m) de atenção" in TrayState("busy", ["x"]).text


def test_icon_images(tmp_path: Path) -> None:
    for state in ("idle", "busy", "attention", "stopped", "brand"):
        assert draw(state, 32).size == (32, 32)
    ico = save_ico(tmp_path / "robo.ico")
    assert ico.read_bytes()[:4] == b"\x00\x00\x01\x00"  # cabeçalho de arquivo .ico
