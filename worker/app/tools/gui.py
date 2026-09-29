"""Janela das ferramentas do JR Sistema (menu Iniciar / ícone do robô).

Feita com o tkinter, que vem com o Python do robô: nada a mais para instalar.
A ferramenta roda numa thread de trabalho e conversa com a janela por `WindowUI`
(um `ToolUI`); cada pergunta (escolha, confirmação, texto) aparece dentro da
própria janela, e a tela final diz se deu certo e o que fazer.
"""

from __future__ import annotations

import ctypes
import gc
import logging
import sys
import threading
import tkinter as tk
from collections.abc import Callable, Sequence
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Any

from app import __version__
from app.config import PROJECT_ROOT, WORKER_ROOT
from app.tools.ui import Action, Choice

log = logging.getLogger("tools")

# cores do painel (globals.css)
C = {
    "bg": "#f7f7f5",
    "card": "#ffffff",
    "border": "#e8e8e4",
    "text": "#1f2421",
    "muted": "#6b6b66",
    "primary": "#1f7a4d",
    "primary_hover": "#17633d",
    "soft": "#e9f6ef",
    "ok": "#1c7a47",
    "warn": "#9a6205",
    "danger": "#b42323",
}
FONT = "Segoe UI"
LEVEL_ICON = {"ok": ("✔", C["ok"]), "warn": ("!", C["warn"]), "fail": ("✖", C["danger"]), "info": ("•", C["muted"])}


class WindowClosed(RuntimeError):
    """A pessoa fechou a janela enquanto a ferramenta trabalhava."""


def logo_file() -> Path | None:
    for p in (PROJECT_ROOT / "instalador" / "logo-mark.png", PROJECT_ROOT / "branding" / "logo-mark.png"):
        if p.is_file():
            return p
    return None


def icon_file() -> Path | None:
    p = PROJECT_ROOT / "instalador" / "jr-sistema-logo.ico"
    return p if p.is_file() else None


def pythonw() -> str:
    """O Python sem tela preta (pythonw.exe), se existir ao lado do atual."""
    exe = Path(sys.executable)
    w = exe.with_name("pythonw.exe")
    return str(w if w.is_file() else exe)


def message(text: str, error: bool = False) -> None:
    flags = 0x10 if error else 0x40  # MB_ICONERROR | MB_ICONINFORMATION
    ctypes.windll.user32.MessageBoxW(None, text, "JR Sistema Robô", flags | 0x10000)  # MB_SETFOREGROUND


def relaunch_as_admin(args: Sequence[str]) -> int:
    """Abre a mesma ferramenta como administrador (o Windows pede permissão). 0 = abriu."""
    params = " ".join(f'"{a}"' if " " in a else a for a in args)
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", pythonw(), params, str(WORKER_ROOT), 1)
    if rc > 32:
        return 0
    message("É preciso clicar em Sim no pedido de permissão do Windows para continuar.", error=True)
    return 1


class _Scroll(tk.Frame):
    """Área com rolagem (a lista da verificação passa de uma tela)."""

    def __init__(self, master: tk.Misc) -> None:
        super().__init__(master, bg=C["card"])
        self.canvas = tk.Canvas(self, bg=C["card"], highlightthickness=0, bd=0)
        self.bar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = tk.Frame(self.canvas, bg=C["card"])
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.bar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.bar.pack(side="right", fill="y")
        self.inner.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self._win, width=e.width))
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(int(-e.delta / 120), "units"))

    def scroll_end(self) -> None:
        self.canvas.update_idletasks()
        self.canvas.yview_moveto(1.0)


class ToolWindow:
    """Cabeçalho com a logo, cartão com as etapas e perguntas, rodapé com andamento e botões."""

    def __init__(self, title: str, subtitle: str = "", *, width: int = 640, height: int = 520) -> None:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # nítido em telas com zoom
        except (AttributeError, OSError):
            pass
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title(f"{title} · JR Sistema")
        self.root.configure(bg=C["bg"])
        self.root.minsize(540, 420)
        icon = icon_file()
        if icon is not None:
            try:
                self.root.iconbitmap(str(icon))
            except tk.TclError:
                pass
        self._images: list[Any] = []
        self._waiting: list[tk.IntVar] = []
        self._busy = False
        self._finished = False
        self._destroyed = False  # marcado pela própria janela; a thread de trabalho só lê
        self._style()
        self._build(title, subtitle)
        self._center(width, height)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.deiconify()

    # -- montagem ----------------------------------------------------------------
    def _style(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "JR.Horizontal.TProgressbar",
            troughcolor=C["border"],
            background=C["primary"],
            bordercolor=C["border"],
            lightcolor=C["primary"],
            darkcolor=C["primary"],
        )
        style.configure("Vertical.TScrollbar", troughcolor=C["card"], background=C["border"], bordercolor=C["card"])

    def _logo(self, size: int) -> Any:
        path = logo_file()
        if path is None:
            return None
        try:
            from PIL import Image, ImageTk

            img = Image.open(path).convert("RGBA")
            img.thumbnail((size, size), Image.LANCZOS)
            photo = ImageTk.PhotoImage(img)
        except Exception:  # noqa: BLE001 - sem logo a janela funciona igual
            return None
        self._images.append(photo)
        return photo

    def _build(self, title: str, subtitle: str) -> None:
        head = tk.Frame(self.root, bg=C["bg"])
        head.pack(fill="x", padx=24, pady=(20, 8))
        logo = self._logo(48)
        if logo is not None:
            tk.Label(head, image=logo, bg=C["bg"]).pack(side="left", padx=(0, 14))
        titles = tk.Frame(head, bg=C["bg"])
        titles.pack(side="left", fill="x", expand=True)
        tk.Label(titles, text=title, font=(FONT, 15, "bold"), fg=C["text"], bg=C["bg"], anchor="w").pack(fill="x")
        if subtitle:
            self._subtitle = tk.Label(
                titles, text=subtitle, font=(FONT, 10), fg=C["muted"], bg=C["bg"], anchor="w", justify="left"
            )
            self._subtitle.pack(fill="x")

        card = tk.Frame(self.root, bg=C["card"], highlightbackground=C["border"], highlightthickness=1)
        card.pack(fill="both", expand=True, padx=24, pady=(8, 0))
        self.scroll = _Scroll(card)
        self.scroll.pack(fill="both", expand=True, padx=1, pady=1)
        self.lines = tk.Frame(self.scroll.inner, bg=C["card"])
        self.lines.pack(fill="x", padx=16, pady=(12, 4))
        self.panel = tk.Frame(self.scroll.inner, bg=C["card"])
        self.panel.pack(fill="x", padx=16, pady=(4, 12))

        foot = tk.Frame(self.root, bg=C["bg"])
        foot.pack(fill="x", padx=24, pady=(10, 14))
        self.progress = ttk.Progressbar(foot, mode="indeterminate", style="JR.Horizontal.TProgressbar")
        self.status = tk.Label(foot, text="", font=(FONT, 10), fg=C["muted"], bg=C["bg"], anchor="w", justify="left")
        self.status.pack(fill="x")
        self.buttons = tk.Frame(foot, bg=C["bg"])
        self.buttons.pack(fill="x", pady=(8, 0))
        tk.Label(
            foot, text=f"JR Sistema Robô {__version__}", font=(FONT, 8), fg=C["muted"], bg=C["bg"], anchor="e"
        ).pack(fill="x", pady=(6, 0))
        self.root.bind("<Configure>", self._reflow)
        # janela destruída no meio de uma pergunta: solta quem estava esperando a resposta
        self.root.bind("<Destroy>", lambda e: self._on_destroy() if str(e.widget) == str(self.root) else None)

    def _center(self, width: int, height: int) -> None:
        self.root.update_idletasks()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"{width}x{height}+{max(0, (sw - width) // 2)}+{max(0, (sh - height) // 2 - 30)}")

    def _reflow(self, _event: Any = None) -> None:
        """Quebra de linha dos textos acompanha a largura da janela."""
        wrap = max(300, self.root.winfo_width() - 140)
        for frame in (self.lines, self.panel):
            for row in frame.winfo_children():
                for w in [row, *row.winfo_children()]:
                    if isinstance(w, tk.Label) and w.cget("text") and len(w.cget("text")) > 40:
                        w.configure(wraplength=wrap)
        self.status.configure(wraplength=max(300, self.root.winfo_width() - 60))
        if hasattr(self, "_subtitle"):
            self._subtitle.configure(wraplength=max(300, self.root.winfo_width() - 130))

    def button(self, master: tk.Misc, text: str, command: Callable[[], None], *, primary: bool = False) -> tk.Button:
        bg, fg = (C["primary"], "white") if primary else (C["card"], C["text"])
        return tk.Button(
            master,
            text=text,
            command=command,
            font=(FONT, 10, "bold" if primary else "normal"),
            bg=bg,
            fg=fg,
            activebackground=C["primary_hover"] if primary else C["soft"],
            activeforeground=fg,
            relief="flat",
            bd=0,
            padx=16,
            pady=7,
            cursor="hand2",
            highlightbackground=C["border"],
            highlightthickness=0 if primary else 1,
        )

    # -- chamadas da thread de trabalho -------------------------------------------
    def call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """Roda `fn` na thread da janela e devolve o resultado (bloqueia quem chamou)."""
        if threading.current_thread() is threading.main_thread():
            return fn(*args, **kwargs)
        done = threading.Event()
        box: dict[str, Any] = {}

        def runner() -> None:
            try:
                box["result"] = fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - devolvido para a thread de trabalho
                box["error"] = exc
            finally:
                done.set()

        if self._destroyed:
            raise WindowClosed
        try:
            self.root.after(0, runner)
        except tk.TclError as exc:
            raise WindowClosed from exc
        while not done.wait(0.2):
            if self._destroyed:  # janela fechada antes de a pergunta ser respondida
                raise WindowClosed
        if "error" in box:
            raise box["error"]
        if self._destroyed:
            raise WindowClosed
        return box.get("result")

    def _closed(self) -> bool:
        return self._destroyed

    # -- conteúdo -------------------------------------------------------------------
    def add_line(self, level: str, text: str) -> None:
        icon, color = LEVEL_ICON.get(level, LEVEL_ICON["info"])
        row = tk.Frame(self.lines, bg=C["card"])
        row.pack(fill="x", pady=2)
        tk.Label(row, text=icon, font=(FONT, 10, "bold"), fg=color, bg=C["card"], width=2, anchor="w").pack(side="left")
        tk.Label(
            row,
            text=text,
            font=(FONT, 10),
            fg=C["muted"] if level == "info" else C["text"],
            bg=C["card"],
            anchor="w",
            justify="left",
            wraplength=max(300, self.root.winfo_width() - 140),
        ).pack(side="left", fill="x", expand=True)
        self.scroll.scroll_end()

    def set_status(self, text: str) -> None:
        self.status.configure(text=text)
        self.busy(bool(text))

    def busy(self, flag: bool) -> None:
        if flag and not self._busy:
            self.progress.pack(fill="x", pady=(0, 6), before=self.status)
            self.progress.start(12)
        elif not flag and self._busy:
            self.progress.stop()
            self.progress.pack_forget()
        self._busy = flag

    def _clear(self, frame: tk.Frame) -> None:
        for w in frame.winfo_children():
            w.destroy()

    def _panel(self, prompt: str, detail: str = "") -> tk.Frame:
        self._clear(self.panel)
        self._clear(self.buttons)
        tk.Label(
            self.panel, text=prompt, font=(FONT, 11, "bold"), fg=C["text"], bg=C["card"], anchor="w", justify="left"
        ).pack(fill="x", pady=(6, 2))
        if detail:
            tk.Label(
                self.panel, text=detail, font=(FONT, 10), fg=C["muted"], bg=C["card"], anchor="w", justify="left"
            ).pack(fill="x", pady=(0, 6))
        self._reflow()
        return self.panel

    def _wait(self, result: tk.IntVar) -> int:
        self._waiting.append(result)
        self.root.wait_variable(result)
        if result in self._waiting:
            self._waiting.remove(result)
        if not self._closed():
            self._clear(self.panel)
            self._clear(self.buttons)
        return result.get()

    def choose(self, prompt: str, choices: Sequence[Choice], *, default: int = 0) -> int | None:
        panel = self._panel(prompt)
        var = tk.IntVar(value=default)
        for i, c in enumerate(choices):
            row = tk.Frame(panel, bg=C["card"], highlightbackground=C["border"], highlightthickness=1, cursor="hand2")
            row.pack(fill="x", pady=4)
            if c.detail:
                tk.Label(
                    row, text=c.detail, font=(FONT, 9), fg=C["muted"], bg=C["card"], anchor="w", justify="left", padx=34
                ).pack(side="bottom", fill="x", pady=(0, 6))
            tk.Radiobutton(
                row,
                text=c.label,
                variable=var,
                value=i,
                font=(FONT, 10, "bold"),
                fg=C["text"],
                bg=C["card"],
                activebackground=C["card"],
                activeforeground=C["text"],
                selectcolor=C["card"],
                anchor="w",
                padx=10,
                pady=6,
                highlightthickness=0,
            ).pack(side="left", fill="x", expand=True)
            if c.badge:
                tk.Label(row, text=c.badge, font=(FONT, 9), fg=C["ok"], bg=C["soft"], padx=8, pady=2).pack(
                    side="right", padx=10
                )
            row.bind("<Button-1>", lambda _e, i=i: var.set(i))
        result = tk.IntVar(value=-1)
        self.button(self.buttons, "Cancelar", lambda: result.set(0)).pack(side="right", padx=(8, 0))
        self.button(self.buttons, "Continuar", lambda: result.set(1), primary=True).pack(side="right")
        return var.get() if self._wait(result) == 1 else None

    def confirm(self, prompt: str, detail: str = "", *, yes: str = "Sim", no: str = "Não") -> bool:
        self._panel(prompt, detail)
        result = tk.IntVar(value=-1)
        self.button(self.buttons, no, lambda: result.set(0)).pack(side="right", padx=(8, 0))
        self.button(self.buttons, yes, lambda: result.set(1), primary=True).pack(side="right")
        return self._wait(result) == 1

    def ask_text(
        self, prompt: str, detail: str = "", *, initial: str = "", transform: Callable[[str], str] | None = None
    ) -> str | None:
        panel = self._panel(prompt, detail)
        value = tk.StringVar(value=initial)
        if transform is not None:
            value.trace_add("write", lambda *_a: value.set(transform(value.get())) if value.get() != transform(value.get()) else None)
        entry = tk.Entry(
            panel,
            textvariable=value,
            font=(FONT, 14),
            relief="flat",
            highlightbackground=C["border"],
            highlightcolor=C["primary"],
            highlightthickness=2,
            bg=C["bg"],
            fg=C["text"],
            insertbackground=C["text"],
        )
        entry.pack(fill="x", ipady=8, pady=(4, 8))
        result = tk.IntVar(value=-1)
        entry.bind("<Return>", lambda _e: result.set(1))
        entry.focus_set()
        self.button(self.buttons, "Cancelar", lambda: result.set(0)).pack(side="right", padx=(8, 0))
        self.button(self.buttons, "Continuar", lambda: result.set(1), primary=True).pack(side="right")
        answer = value.get().strip()
        return answer if self._wait(result) == 1 and (answer := value.get().strip()) else None

    def finish(self, ok: bool, title: str, detail: str = "", actions: Sequence[Action] = ()) -> None:
        self._finished = True
        self.set_status("")
        self._clear(self.panel)
        self._clear(self.buttons)
        box = tk.Frame(self.panel, bg=C["card"])
        box.pack(fill="x", pady=(8, 4))
        icon, color = (("✔", C["ok"]) if ok else ("✖", C["danger"]))
        tk.Label(box, text=icon, font=(FONT, 22, "bold"), fg=color, bg=C["card"]).pack(side="left", padx=(0, 12), anchor="n")
        texts = tk.Frame(box, bg=C["card"])
        texts.pack(side="left", fill="x", expand=True)
        tk.Label(texts, text=title, font=(FONT, 12, "bold"), fg=C["text"], bg=C["card"], anchor="w", justify="left").pack(fill="x")
        if detail:
            tk.Label(texts, text=detail, font=(FONT, 10), fg=C["muted"], bg=C["card"], anchor="w", justify="left").pack(
                fill="x", pady=(4, 0)
            )
        self.button(self.buttons, "Fechar", self.close, primary=True).pack(side="right")
        for label, command in reversed(list(actions)):
            self.button(self.buttons, label, command).pack(side="right", padx=(0, 8))
        self._reflow()
        self.scroll.scroll_end()

    # -- ciclo ------------------------------------------------------------------------
    def run(self) -> None:
        self.root.mainloop()

    def dispose(self) -> None:
        """Libera a janela na thread principal.

        O Tcl só pode ser liberado pela thread que o criou; se a coleta de lixo do
        Python o liberasse noutra thread, o processo cairia (erro fatal do Windows).
        """
        if not self._destroyed:
            self._release_waiting()
            try:
                self.root.destroy()
            except tk.TclError:
                pass
            self._destroyed = True
        self._images.clear()
        gc.collect()

    def _on_destroy(self) -> None:
        self._destroyed = True
        self._release_waiting()

    def _release_waiting(self) -> None:
        for var in list(self._waiting):
            try:
                var.set(0)
            except tk.TclError:
                pass
        self._waiting.clear()

    def close(self) -> None:
        if self._busy and not self._finished:
            if not messagebox.askyesno("JR Sistema", "A ferramenta ainda está trabalhando. Fechar mesmo assim?"):
                return
        self._release_waiting()
        try:
            self.root.destroy()
        except tk.TclError:
            pass


class WindowUI:
    """`ToolUI` para a janela, chamado da thread de trabalho."""

    def __init__(self, window: ToolWindow) -> None:
        self.window = window

    def info(self, text: str) -> None:
        self.window.call(self.window.add_line, "info", text)

    def ok(self, text: str) -> None:
        self.window.call(self.window.add_line, "ok", text)

    def warn(self, text: str) -> None:
        self.window.call(self.window.add_line, "warn", text)

    def fail(self, text: str) -> None:
        self.window.call(self.window.add_line, "fail", text)

    def status(self, text: str) -> None:
        self.window.call(self.window.set_status, text)

    def choose(self, prompt: str, choices: Sequence[Choice], *, default: int = 0) -> int | None:
        return self.window.call(self.window.choose, prompt, choices, default=default)

    def confirm(self, prompt: str, detail: str = "", *, yes: str = "Sim", no: str = "Não") -> bool:
        return self.window.call(self.window.confirm, prompt, detail, yes=yes, no=no)

    def ask_text(
        self, prompt: str, detail: str = "", *, initial: str = "", transform: Callable[[str], str] | None = None
    ) -> str | None:
        return self.window.call(self.window.ask_text, prompt, detail, initial=initial, transform=transform)

    def done(self, ok: bool, title: str, detail: str = "", actions: Sequence[Action] = ()) -> None:
        self.window.call(self.window.finish, ok, title, detail, actions)


def run_in_window(
    title: str, subtitle: str, work: Callable[[WindowUI], int | None], *, width: int = 640, height: int = 520
) -> int:
    """Abre a janela e roda `work(ui)` numa thread. Devolve o código que `work` devolveu."""
    window = ToolWindow(title, subtitle, width=width, height=height)
    ui = WindowUI(window)
    outcome = {"rc": 1}

    def target() -> None:
        try:
            outcome["rc"] = int(work(ui) or 0)
        except WindowClosed:
            pass
        except Exception as exc:  # noqa: BLE001 - mensagem clara em vez de janela sumindo
            log.exception("Erro na ferramenta %s", title)
            try:
                ui.done(
                    False,
                    "Erro inesperado",
                    f"{exc}\n\nNada foi apagado. Se a mensagem continuar, fale com o suporte do JR Sistema.",
                )
            except WindowClosed:
                pass

    worker = threading.Thread(target=target, daemon=True, name="ferramenta")
    worker.start()
    window.run()
    worker.join(5)  # a thread de trabalho recebe WindowClosed e termina
    window.dispose()
    del ui, worker, target
    gc.collect()
    return outcome["rc"]
