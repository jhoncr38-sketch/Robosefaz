"""Conversa das ferramentas (menu Iniciar / ícone do robô) com quem está usando.

As ferramentas (Salvar notas no Google Drive, Ativar este computador, Status e
verificação) só falam com um `ToolUI`. `ConsoleUI` escreve na tela preta (.bat,
instalador e testes); `app.tools.gui.WindowUI` mostra uma janela com a cara do
JR Sistema. A regra de cada ferramenta é a mesma nos dois casos.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class Choice:
    label: str
    detail: str = ""
    badge: str = ""  # ex.: 'já tem a pasta "JR Sistema - Notas"'


# botão extra na tela final: (texto, o que fazer ao clicar)
Action = tuple[str, Callable[[], None]]


class ToolUI(Protocol):
    def info(self, text: str) -> None: ...
    def ok(self, text: str) -> None: ...
    def warn(self, text: str) -> None: ...
    def fail(self, text: str) -> None: ...
    def status(self, text: str) -> None:
        """O que está sendo feito agora (com a barra de andamento); "" = nada."""

    def choose(self, prompt: str, choices: Sequence[Choice], *, default: int = 0) -> int | None:
        """Índice escolhido; None = cancelou."""

    def confirm(self, prompt: str, detail: str = "", *, yes: str = "Sim", no: str = "Não") -> bool: ...
    def ask_text(self, prompt: str, detail: str = "", *, initial: str = "") -> str | None:
        """Texto digitado; None = cancelou."""

    def done(self, ok: bool, title: str, detail: str = "", actions: Sequence[Action] = ()) -> None:
        """Tela final: deu certo (ok) ou não, com o que aconteceu e o que fazer."""


def _input(prompt: str) -> str:
    try:
        return input(prompt)
    except EOFError:
        return ""


class ConsoleUI:
    """Tela preta: os prefixos [OK]/[ATENCAO]/[ERRO] são os que o instalador lê no relatório."""

    def __init__(self, ask: Callable[[str], str] | None = None, out: Callable[[str], None] = print) -> None:
        self._ask = ask or _input
        self._out = out

    def info(self, text: str) -> None:
        self._out(text)

    def ok(self, text: str) -> None:
        self._out(f"  [OK]       {text}")

    def warn(self, text: str) -> None:
        self._out(f"  [ATENCAO]  {text}")

    def fail(self, text: str) -> None:
        self._out(f"  [ERRO]     {text}")

    def status(self, text: str) -> None:
        if text:
            self._out(text)

    def choose(self, prompt: str, choices: Sequence[Choice], *, default: int = 0) -> int | None:
        self._out(prompt)
        for i, c in enumerate(choices, 1):
            extra = f"  ({c.badge})" if c.badge else ""
            self._out(f"  {i}) {c.label}{extra}")
            if c.detail:
                self._out(f"     {c.detail}")
        answer = self._ask(f"Qual usar? [1-{len(choices)}, Enter = {default + 1}] ").strip()
        if not answer:
            return default
        try:
            n = int(answer)
        except ValueError:
            return None
        return n - 1 if 1 <= n <= len(choices) else None

    def confirm(self, prompt: str, detail: str = "", *, yes: str = "Sim", no: str = "Não") -> bool:
        self._out(prompt)
        if detail:
            self._out(detail)
        return self._ask(f"{yes}? [s/N] ").strip().lower() in ("s", "sim", "y")

    def ask_text(self, prompt: str, detail: str = "", *, initial: str = "") -> str | None:
        if detail:
            self._out(detail)
        answer = self._ask(f"{prompt}: ").strip()
        return answer or initial or None

    def done(self, ok: bool, title: str, detail: str = "", actions: Sequence[Action] = ()) -> None:
        self._out("")
        self._out(title)
        if detail:
            self._out(detail)
