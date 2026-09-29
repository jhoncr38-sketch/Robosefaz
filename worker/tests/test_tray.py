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


def test_brand_icon_uses_logo_from_32px(tmp_path: Path) -> None:
    from PIL import Image

    logo = Path(__file__).resolve().parents[2] / "branding" / "logo-mark.png"
    ico = save_ico(tmp_path / "jr.ico", logo=logo)
    with Image.open(ico) as im:
        assert {(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)} <= set(im.info["sizes"])
        im.size = (256, 256)
        big = im.convert("RGBA")
    # 256 px é a logo da marca: o "J" verde ocupa o canto inferior esquerdo (a cabeça do robô não)
    r, g, b, a = big.getpixel((30, 200))
    assert a > 0 and g > r
    assert draw("brand", 256).getpixel((30, 200))[3] == 0


def test_menu_order_and_help_submenu(settings) -> None:  # noqa: ANN001
    """Menu do ícone: uso diário, controle, configuração/ajuda e Sair (nesta ordem)."""
    from app import __version__
    from app.tray import RobotTray

    tray = RobotTray(settings)
    items = list(tray.icon.menu.items)
    texts = [i.text for i in items]  # o pystray já resolve os textos dinâmicos
    assert texts == [
        "Robô parado",  # estado do robô (sem worker rodando no teste)
        f"Versão {__version__}",
        "Precisam de atenção (0)",  # escondido enquanto não há pendências
        "- - - -",
        "Abrir painel",
        "Abrir pasta das notas",
        "- - - -",
        "Ligar robô",
        "Parar robô",
        "Atualizar agora (versão None)",  # escondido enquanto não há versão nova
        "- - - -",
        "Status e verificação",
        "Salvar notas no Google Drive",
        "⚠ Ativar este computador…",
        "Ajuda e suporte",
        "- - - -",
        "Sair",
    ]
    help_menu = [i.text for i in items[-3].submenu.items]
    assert help_menu == ["Manual do JR Sistema", "Falar com o suporte (WhatsApp)", "Mensagens do robô (log)"]
    assert items[4].default  # duplo clique no ícone = Abrir painel
