"""Navegador do robô escondido fora da tela: abrir, mostrar, esconder e intervenção."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.browser import window as w
from app.browser.window import SHOW_AT, RobotWindows, hidden_launch_args, offscreen_origin


class FakeCDP:
    def __init__(self, page: "FakePage") -> None:
        self.page = page

    async def send(self, method: str, params: dict | None = None) -> dict:
        if method == "Browser.getWindowForTarget":
            return {"windowId": self.page.window_id, "bounds": {"windowState": self.page.state}}
        assert method == "Browser.setWindowBounds"
        bounds = params["bounds"]  # type: ignore[index]
        if "windowState" in bounds:
            self.page.state = bounds["windowState"]
        else:
            self.page.context.moves.append((self.page.window_id, bounds["left"], bounds["top"]))
        return {}

    async def detach(self) -> None:
        pass


class FakePage:
    def __init__(self, context: "FakeContext", window_id: int, state: str = "normal") -> None:
        self.context = context
        self.window_id = window_id
        self.state = state
        self.closed = False
        self.fronted = 0

    def is_closed(self) -> bool:
        return self.closed

    async def bring_to_front(self) -> None:
        self.fronted += 1


class FakeContext:
    def __init__(self) -> None:
        self.pages: list[FakePage] = []
        self.moves: list[tuple[int, int, int]] = []
        self.handlers: dict[str, object] = {}

    def add_page(self, window_id: int, state: str = "normal") -> FakePage:
        page = FakePage(self, window_id, state)
        self.pages.append(page)
        return page

    def on(self, event: str, handler) -> None:  # noqa: ANN001
        self.handlers[event] = handler

    async def new_cdp_session(self, page: FakePage) -> FakeCDP:
        return FakeCDP(page)


@pytest.fixture(autouse=True)
def no_win32_focus(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Os testes nunca mexem no foco de verdade do Windows."""
    calls: list[str] = []
    monkeypatch.setattr(w, "give_back_focus", lambda previous=0: calls.append(f"devolve:{previous}") or False)
    monkeypatch.setattr(w, "bring_own_window_to_front", lambda: calls.append("frente") or True)
    monkeypatch.setattr(w, "offscreen_origin", lambda screen=None: (3000, 2000))
    monkeypatch.setattr(RobotWindows, "FOCUS_WATCH", (0, 0.01))
    return calls


def test_offscreen_origin_is_past_every_monitor() -> None:
    # monitor à esquerda do principal (x negativo) + principal 1366 de largura
    assert offscreen_origin((-1920, 0, 3286, 1080)) == (1566, 1280)
    assert offscreen_origin((0, 0, 1366, 768)) == (1566, 968)


def test_launch_args_only_when_hidden_with_window() -> None:
    assert hidden_launch_args(headless=True, window="hidden") == []
    assert hidden_launch_args(headless=False, window="visible") == []
    args = hidden_launch_args(headless=False, window="hidden")
    assert args == (["--window-position=3000,2000"] if sys.platform == "win32" else [])


async def test_register_hides_then_show_and_hide(no_win32_focus: list[str]) -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    page = ctx.add_page(1)
    assert windows.state == "none"
    await windows.register(ctx, previous_foreground=77)  # type: ignore[arg-type]
    assert windows.state == "hidden"
    assert ctx.moves == [(1, 3000, 2000)]

    assert await windows.show(reason="user")
    assert windows.state == "shown"
    assert ctx.moves[-1] == (1, *SHOW_AT)
    assert page.fronted == 1 and "frente" in no_win32_focus  # clicou no ícone: vem para a frente

    assert await windows.hide()
    assert windows.state == "hidden"
    assert ctx.moves[-1] == (1, 3000, 2000)

    windows.unregister(ctx)  # type: ignore[arg-type]
    assert windows.state == "none"
    assert not await windows.show() and not await windows.hide()


async def test_minimized_window_is_restored_and_tabs_of_same_window_move_once() -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    first = ctx.add_page(5, state="minimized")
    ctx.add_page(5)  # outra aba na mesma janela
    await windows.register(ctx)  # type: ignore[arg-type]
    assert first.state == "normal"
    assert ctx.moves == [(5, 3000, 2000)]


async def test_popup_opened_while_hidden_is_hidden_too() -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    ctx.add_page(1)
    await windows.register(ctx)  # type: ignore[arg-type]
    popup = ctx.add_page(2)
    await ctx.handlers["page"](popup)  # type: ignore[operator]
    assert ctx.moves[-1] == (2, 3000, 2000)

    await windows.show()
    shown_popup = ctx.add_page(3)
    moves = len(ctx.moves)
    await ctx.handlers["page"](shown_popup)  # type: ignore[operator]
    assert len(ctx.moves) == moves  # com a janela à mostra, o pop-up fica onde nasceu


async def test_intervention_shows_without_stealing_focus_and_hides_after(no_win32_focus: list[str]) -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    page = ctx.add_page(1)
    await windows.register(ctx)  # type: ignore[arg-type]
    async with windows.shown_for_intervention():
        assert windows.state == "shown"
        assert page.fronted == 0 and "frente" not in no_win32_focus  # aparece, mas não rouba o foco
    assert windows.state == "hidden"


async def test_intervention_keeps_window_if_user_asked_to_show_it() -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    ctx.add_page(1)
    await windows.register(ctx)  # type: ignore[arg-type]
    async with windows.shown_for_intervention():
        await windows.show(reason="user")  # a pessoa clicou em "Mostrar navegador do robô"
    assert windows.state == "shown"

    # já estava à mostra antes do pedido: continua à mostra depois
    async with windows.shown_for_intervention():
        pass
    assert windows.state == "shown"


class Desk:
    """Janela na frente e último clique/tecla da pessoa, simulados."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.front = 1  # 1 = janela da pessoa; 99 = Chrome do robô
        self.input_age = 60.0
        self.on_taskbar = False
        self.given_back: list[int] = []
        monkeypatch.setattr(w, "foreground_window", lambda: self.front)
        monkeypatch.setattr(w, "own_windows", lambda: [99])
        monkeypatch.setattr(w, "last_input_age", lambda: self.input_age)
        monkeypatch.setattr(w, "cursor_on_taskbar", lambda: self.on_taskbar)
        monkeypatch.setattr(w, "give_back_focus", self._give_back)

    def _give_back(self, previous: int = 0) -> bool:
        if self.front != 99:
            return False
        self.given_back.append(previous)
        self.front = previous or 2
        return True


async def _hidden(windows: RobotWindows) -> FakeContext:
    ctx = FakeContext()
    ctx.add_page(1)
    await windows.register(ctx)  # type: ignore[arg-type]
    await windows._focus_task  # type: ignore[misc]  # fim do "vigia" dos primeiros segundos
    return ctx


async def test_hidden_chrome_never_keeps_the_focus(monkeypatch: pytest.MonkeyPatch) -> None:
    desk = Desk(monkeypatch)
    windows = RobotWindows()
    await _hidden(windows)
    assert await windows.guard_focus() is None  # pessoa usando a janela 1
    desk.front = 99  # Chrome escondido se ativou sozinho (ninguém clicou)
    assert await windows.guard_focus() == "focus"
    assert desk.given_back == [1] and desk.front == 1
    assert windows.state == "hidden"


async def test_robot_tab_switch_gives_focus_back_even_while_person_types(monkeypatch: pytest.MonkeyPatch) -> None:
    desk = Desk(monkeypatch)
    windows = RobotWindows()
    await _hidden(windows)
    desk.input_age = 0.2  # a pessoa está digitando
    desk.front = 99  # robô trocou de aba no SIAT (page.bring_to_front ativa a janela)
    windows.robot_activated(previous=1)
    assert desk.given_back == [1]  # devolvido na hora, dentro do próprio passo do robô
    desk.front = 99  # se ainda assim ficou na frente, o vigia devolve em vez de mostrar
    assert await windows.guard_focus() == "focus"
    assert windows.state == "hidden"


async def test_click_on_taskbar_button_reveals_hidden_window(monkeypatch: pytest.MonkeyPatch) -> None:
    desk = Desk(monkeypatch)
    windows = RobotWindows()
    await _hidden(windows)
    assert await windows.guard_focus() is None
    desk.front, desk.input_age, desk.on_taskbar = 99, 0.3, True  # clicou no botão do Chrome na barra de tarefas
    assert await windows.guard_focus() == "shown"
    assert windows.state == "shown"
    assert await windows.guard_focus() is None  # à mostra: o vigia não mexe


async def test_chrome_activating_itself_while_person_types_is_not_a_click(monkeypatch: pytest.MonkeyPatch) -> None:
    """Visto no SIAT real: o Chrome se ativa sozinho no login com certificado, com a pessoa digitando."""
    desk = Desk(monkeypatch)
    windows = RobotWindows()
    await _hidden(windows)
    assert await windows.guard_focus() is None  # pessoa na janela 1
    desk.front, desk.input_age = 99, 0.2  # digitando em outra janela; mouse longe da barra de tarefas
    assert await windows.guard_focus() == "focus"
    assert windows.state == "hidden" and desk.front == 1


async def test_focus_taken_right_after_opening_is_not_a_click(monkeypatch: pytest.MonkeyPatch) -> None:
    desk = Desk(monkeypatch)
    desk.front, desk.input_age = 99, 0.1  # o Chrome pegou o foco ao abrir, com a pessoa digitando
    windows = RobotWindows()
    ctx = FakeContext()
    ctx.add_page(1)
    await windows.register(ctx)  # type: ignore[arg-type]
    assert await windows.guard_focus() == "focus"  # ainda no vigia dos primeiros segundos: devolve
    assert windows.state == "hidden"


async def test_bring_tab_to_front_marks_robot_activation(monkeypatch: pytest.MonkeyPatch) -> None:
    desk = Desk(monkeypatch)
    windows = RobotWindows()
    await _hidden(windows)
    monkeypatch.setattr(w, "robot_windows", windows)
    page = FakePage(FakeContext(), 1)

    async def front() -> None:
        page.fronted += 1
        desk.front = 99  # no Windows, trazer a aba para a frente ativa a janela

    page.bring_to_front = front  # type: ignore[method-assign]
    await w.bring_tab_to_front(page)  # type: ignore[arg-type]
    assert page.fronted == 1 and desk.front == 1 and desk.given_back == [1]


async def test_always_visible_mode(no_win32_focus: list[str]) -> None:
    windows = RobotWindows()
    ctx = FakeContext()
    ctx.add_page(1)
    await windows.register(ctx, hidden=False)  # type: ignore[arg-type]  # abriu visível (modo sempre visível)
    assert windows.state == "shown" and ctx.moves == []  # fica onde o Chrome abriu
    async with windows.shown_for_intervention():
        pass
    assert windows.state == "shown"  # intervenção não esconde nada no modo visível

    await windows.set_always_visible(False)  # desligou no ícone: esconde na hora
    assert windows.state == "hidden" and ctx.moves[-1] == (1, 3000, 2000) and not windows.always_visible
    await windows.set_always_visible(True)  # ligou de novo: aparece na hora
    assert windows.state == "shown" and ctx.moves[-1] == (1, *SHOW_AT) and windows.always_visible


async def test_intervention_without_browser_is_a_no_op() -> None:
    windows = RobotWindows()
    async with windows.shown_for_intervention():
        assert windows.state == "none"


async def test_worker_handles_browser_flag_from_tray(settings, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    from app import worker as worker_mod
    from fakes import FakeRepo

    calls: list[str] = []

    async def show(*, reason: str = "user") -> bool:
        calls.append(f"mostrar:{reason}")
        return True

    async def hide() -> bool:
        calls.append("esconder")
        return True

    monkeypatch.setattr(worker_mod.robot_windows, "show", show)
    monkeypatch.setattr(worker_mod.robot_windows, "hide", hide)
    worker = worker_mod.Worker(FakeRepo(), settings, mode="none")

    settings.browser_flag.write_text("mostrar", encoding="utf-8")
    assert await worker.handle_browser_flag()
    assert not settings.browser_flag.exists()
    settings.browser_flag.write_text("esconder\n", encoding="utf-8")
    assert await worker.handle_browser_flag()
    settings.browser_flag.write_text("qualquer coisa", encoding="utf-8")
    assert not await worker.handle_browser_flag()
    modes: list[bool] = []

    async def set_always_visible(on: bool) -> None:
        modes.append(on)

    monkeypatch.setattr(worker_mod.robot_windows, "set_always_visible", set_always_visible)
    settings.browser_flag.write_text("visivel", encoding="utf-8")
    assert await worker.handle_browser_flag()
    assert settings.browser_window == "visible"  # próximos trabalhos já abrem visíveis
    assert json.loads(Path(settings.status_file).read_text(encoding="utf-8"))["browser_mode"] == "visible"
    settings.browser_flag.write_text("oculto", encoding="utf-8")
    assert await worker.handle_browser_flag()
    assert settings.browser_window == "hidden" and modes == [True, False]
    settings.browser_flag.write_text("qualquer coisa", encoding="utf-8")
    assert not await worker.handle_browser_flag()
    assert not await worker.handle_browser_flag()  # sem arquivo
    assert calls == ["mostrar:user", "esconder"]
    status = json.loads(Path(settings.status_file).read_text(encoding="utf-8"))
    assert status["browser"] == "none"  # nenhum navegador aberto neste teste


def test_config_accepts_only_hidden_or_visible(settings) -> None:  # noqa: ANN001
    from app.config import Settings

    assert settings.browser_window == "hidden"  # padrão: janela fora da tela
    assert Settings(browser_window=" VISIBLE ").browser_window == "visible"
    with pytest.raises(ValueError):
        Settings(browser_window="minimizada")
