"""Janela das ferramentas (tkinter) e a conversa ToolUI (tela preta e janela)."""

from __future__ import annotations

import pytest

from app.tools.ui import Choice, ConsoleUI


def test_console_ui_choose_and_confirm() -> None:
    out: list[str] = []
    answers = iter(["", "2", "x", "9", "s", "n"])
    ui = ConsoleUI(ask=lambda _q: next(answers), out=out.append)
    choices = [Choice("G:", badge="já tem a pasta"), Choice("H:", detail="seria criada")]
    assert ui.choose("Qual?", choices, default=1) == 1  # Enter = padrão
    assert ui.choose("Qual?", choices) == 1
    assert ui.choose("Qual?", choices) is None  # resposta inválida = cancelou
    assert ui.choose("Qual?", choices) is None  # fora da lista
    assert ui.confirm("Criar?", yes="Criar a pasta") is True
    assert ui.confirm("Criar?") is False
    assert "  1) G:  (já tem a pasta)" in out and "     seria criada" in out
    ui.ok("a")
    ui.warn("b")
    ui.fail("c")
    assert out[-3:] == ["  [OK]       a", "  [ATENCAO]  b", "  [ERRO]     c"]  # o instalador lê estes prefixos


def _window(title: str = "Teste"):
    tk = pytest.importorskip("tkinter")
    from app.tools import gui

    try:
        win = gui.ToolWindow(title, "subtítulo")
    except tk.TclError:
        pytest.skip("sem tela para abrir janelas")
    win.root.withdraw()
    return win


def test_window_dialogs() -> None:
    win = _window()
    try:
        win.add_line("ok", "linha ok")
        win.add_line("fail", "linha erro")
        win.set_status("trabalhando…")
        assert win._busy
        # as perguntas esperam o clique; aqui o "clique" é agendado
        win.root.after(50, lambda: win._waiting[-1].set(1))
        assert win.choose("Qual?", [Choice("a"), Choice("b", badge="x")], default=1) == 1
        win.root.after(50, lambda: win._waiting[-1].set(0))
        assert win.choose("Qual?", [Choice("a"), Choice("b")]) is None  # Cancelar
        win.root.after(50, lambda: win._waiting[-1].set(1))
        assert win.confirm("Criar?", "detalhe", yes="Criar") is True
        win.root.after(50, lambda: win._waiting[-1].set(1))
        assert win.ask_text("Código", initial="abcd") == "abcd"
        win.root.after(50, lambda: win._waiting[-1].set(0))
        assert win.ask_text("Código") is None
        win.finish(True, "Pronto!", "detalhe", actions=[("Abrir", lambda: None)])
        assert not win._busy and win._finished
        assert len(win.buttons.winfo_children()) == 2  # Abrir + Fechar
    finally:
        win.dispose()  # libera o Tk aqui, na thread principal (senão outro teste pode cair)


def test_run_in_window_from_worker_thread() -> None:
    pytest.importorskip("tkinter")
    from app.tools import gui

    seen: dict[str, object] = {}

    def work(ui: gui.WindowUI) -> int:
        win = ui.window
        ui.info("começando")
        ui.status("indo…")
        win.call(win.root.after, 50, lambda: win._waiting[-1].set(1))
        seen["choice"] = ui.choose("Qual?", [Choice("a"), Choice("b")], default=1)
        win.call(win.root.after, 50, lambda: win._waiting[-1].set(1))
        seen["confirm"] = ui.confirm("Ok?")
        ui.done(True, "Fim")
        win.call(win.root.after, 50, win.close)
        return 7

    try:
        rc = gui.run_in_window("Teste", "sub", work)
    except Exception as exc:  # noqa: BLE001 - sem tela
        pytest.skip(f"sem tela para abrir janelas: {exc}")
    assert rc == 7
    assert seen == {"choice": 1, "confirm": True}


def test_closing_the_window_stops_the_worker() -> None:
    pytest.importorskip("tkinter")
    from app.tools import gui

    outcome: dict[str, object] = {}

    def work(ui: gui.WindowUI) -> int:
        win = ui.window
        win.call(win.root.after, 50, win.root.destroy)  # a pessoa fechou no X durante a pergunta
        try:
            ui.choose("Qual?", [Choice("a")])
        except gui.WindowClosed:
            outcome["closed"] = True
            raise
        return 0

    try:
        gui.run_in_window("Teste", "", work)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"sem tela para abrir janelas: {exc}")
    import time

    time.sleep(0.3)  # a thread de trabalho recebe o WindowClosed logo depois
    assert outcome.get("closed") is True
