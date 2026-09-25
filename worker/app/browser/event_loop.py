"""Execução do Playwright em loop compatível no Windows.

O Playwright inicia o navegador como subprocesso, o que exige o
ProactorEventLoop no Windows. O uvicorn com --reload usa o SelectorEventLoop,
então nesse caso a rotina roda em uma thread com um loop Proactor próprio.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


def _needs_proactor() -> bool:
    if sys.platform != "win32":
        return False
    return not isinstance(asyncio.get_running_loop(), asyncio.ProactorEventLoop)  # type: ignore[attr-defined]


async def run_playwright(factory: Callable[[], Awaitable[T]]) -> T:
    """Executa `factory()` num loop capaz de criar subprocessos."""
    if not _needs_proactor():
        return await factory()

    def runner() -> T:
        loop = asyncio.ProactorEventLoop()  # type: ignore[attr-defined]
        try:
            return loop.run_until_complete(factory())
        finally:
            loop.close()

    return await asyncio.to_thread(runner)
