"""Ícone da bandeja: estado do robô a partir do arquivo local e cores."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.tray import TrayState, read_browser_mode, read_browser_state, read_local_status
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


def test_browser_state_from_status_file(tmp_path: Path) -> None:
    path = tmp_path / "worker-status.json"

    def write(browser: str | None, age_s: float) -> Path:
        data = {"status": "busy", "updated_at": (NOW - timedelta(seconds=age_s)).isoformat()}
        if browser is not None:
            data["browser"] = browser
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    assert read_browser_state(write("hidden", 2), NOW) == "hidden"
    assert read_browser_state(write("shown", 2), NOW) == "shown"
    assert read_browser_state(write("none", 2), NOW) == "none"
    assert read_browser_state(write(None, 2), NOW) == "none"  # robô de versão antiga
    assert read_browser_state(write("shown", 120), NOW) == "none"  # robô parou
    assert read_browser_state(tmp_path / "nao-existe.json", NOW) == "none"


def test_toggle_browser_writes_request_for_worker(settings, monkeypatch) -> None:  # noqa: ANN001
    from app import tray as tray_mod
    from app.tray import RobotTray

    allowed: list[int] = []
    if tray_mod.sys.platform == "win32":
        monkeypatch.setattr(tray_mod.ctypes.windll.user32, "AllowSetForegroundWindow", lambda v: allowed.append(v))
    tray = RobotTray(settings)
    tray.state.browser = "hidden"
    tray.toggle_browser()
    assert settings.browser_flag.read_text(encoding="utf-8") == "mostrar"
    assert tray.state.browser == "shown"
    tray.toggle_browser()
    assert settings.browser_flag.read_text(encoding="utf-8") == "esconder"
    assert tray.state.browser == "hidden"
    if tray_mod.sys.platform == "win32":
        assert allowed == [-1]  # só ao mostrar: libera o Chrome do robô a vir para a frente


def test_browser_mode_from_status_file(tmp_path: Path) -> None:
    path = tmp_path / "worker-status.json"
    path.write_text(json.dumps({"browser_mode": "visible"}), encoding="utf-8")
    assert read_browser_mode(path) == "visible"
    path.write_text(json.dumps({"browser_mode": "hidden"}), encoding="utf-8")
    assert read_browser_mode(path) == "hidden"
    path.write_text(json.dumps({"status": "idle"}), encoding="utf-8")  # robô de versão antiga
    assert read_browser_mode(path) is None
    assert read_browser_mode(tmp_path / "nao-existe.json") is None


def test_always_visible_toggle_saves_env_and_tells_running_robot(settings, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    from app import tray as tray_mod
    from app.tray import RobotTray

    if tray_mod.sys.platform == "win32":
        monkeypatch.setattr(tray_mod.ctypes.windll.user32, "AllowSetForegroundWindow", lambda v: None)
    tray = RobotTray(settings)
    notices: list[str] = []
    monkeypatch.setattr(tray.icon, "notify", lambda msg, title=None: notices.append(msg))
    tray.env_file = tmp_path / ".env"
    tray.env_file.write_text("SUPABASE_URL=x\nBROWSER_WINDOW=hidden\n", encoding="utf-8")
    item = next(i for i in tray.icon.menu.items if i.text == "Deixar navegador sempre visível")
    assert not item.checked

    tray.state.robot = "busy"
    tray.toggle_always_visible()
    assert tray.env_file.read_text(encoding="utf-8") == "SUPABASE_URL=x\nBROWSER_WINDOW=visible\n"
    assert settings.browser_flag.read_text(encoding="utf-8") == "visivel"  # vale na hora
    assert item.checked and "sempre visível" in notices[-1]

    settings.browser_flag.unlink()
    tray.state.robot = "stopped"
    tray.toggle_always_visible()
    assert "BROWSER_WINDOW=hidden" in tray.env_file.read_text(encoding="utf-8")
    assert not settings.browser_flag.exists()  # robô parado: vale quando ligar (lê o .env)
    assert not item.checked and "escondido" in notices[-1]


def test_show_hide_item_is_disabled_when_always_visible(settings) -> None:  # noqa: ANN001
    from app.tray import RobotTray

    tray = RobotTray(settings)
    item = next(i for i in tray.icon.menu.items if i.text in ("Mostrar navegador do robô", "Esconder navegador do robô"))
    tray.state.browser = "hidden"
    assert item.enabled
    tray.state.always_visible = True
    assert not item.enabled


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
        "Mostrar navegador do robô",  # desabilitado enquanto o robô não abriu o navegador
        "Deixar navegador sempre visível",  # liga/desliga (com marca)
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


def test_refresh_rebuilds_menu_only_when_something_changes(settings, monkeypatch) -> None:  # noqa: ANN001
    """Refazer o menu a cada 5 s, com ele aberto, travava a tela: só quando o conteúdo muda."""
    from types import SimpleNamespace

    from app.tray import RobotTray

    tray = RobotTray(settings)
    rebuilt: list[int] = []
    titles: list[str] = []

    class FakeIcon:
        icon = None

        def update_menu(self) -> None:
            rebuilt.append(1)

        def notify(self, *_a, **_k) -> None:
            pass

        @property
        def title(self) -> str:
            return titles[-1] if titles else ""

        @title.setter
        def title(self, value: str) -> None:
            titles.append(value)

    tray.icon = FakeIcon()
    monkeypatch.setattr(RobotTray, "_reload_if_activated", lambda self: None)
    monkeypatch.setattr("app.tray.read_update_status", lambda s: None)
    for _ in range(3):
        tray._refresh()
    assert len(rebuilt) == 1 and len(titles) == 1  # nada mudou: menu e texto do ícone ficam como estão
    tray.state.attention = ["SELETO 08/2026: falhou"]
    tray._refresh()
    tray._refresh()
    assert len(rebuilt) == 2 and len(titles) == 2  # mudou uma vez: refeito uma vez
    assert SimpleNamespace  # (só para o import não ficar sem uso)
