"""Robô ligando sem internet (ex.: notebook que acabou de acordar): espera em vez de cair."""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings


async def test_waits_for_the_internet_then_connects(settings: Settings, monkeypatch: pytest.MonkeyPatch, caplog) -> None:  # noqa: ANN001
    import app.worker as w

    calls = {"n": 0}

    async def fake_get(_settings):  # noqa: ANN001, ANN202
        calls["n"] += 1
        if calls["n"] < 4:  # 02/10: 6 minutos de "getaddrinfo failed" depois de acordar
            raise httpx.ConnectError("[Errno 11001] getaddrinfo failed")
        return "cliente"

    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(w, "get_supabase", fake_get)
    with caplog.at_level("INFO"):
        assert await w.connect_when_online(settings, sleep=fake_sleep) == "cliente"
    assert waits == [5.0, 10.0, 20.0]  # espera crescente, sem derrubar o robô
    messages = [r.getMessage() for r in caplog.records]
    assert sum("Esperando a internet" in m for m in messages) == 1  # avisa uma vez só
    assert any("Conexão de volta" in m for m in messages)


async def test_stop_or_update_while_waiting(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.worker as w

    async def offline(_settings):  # noqa: ANN001, ANN202
        raise httpx.ConnectError("sem internet")

    async def fake_sleep(_seconds: float) -> None:
        raise AssertionError("não deveria esperar: pediram para parar")

    monkeypatch.setattr(w, "get_supabase", offline)
    settings.stop_flag.parent.mkdir(parents=True, exist_ok=True)
    settings.stop_flag.write_text("x", encoding="utf-8")
    assert await w.connect_when_online(settings, sleep=fake_sleep) is None


async def test_other_errors_are_not_swallowed(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.worker as w
    from app.services.supabase_client import SupabaseNotConfigured

    async def not_activated(_settings):  # noqa: ANN001, ANN202
        raise SupabaseNotConfigured("Este computador não está ativado.")

    monkeypatch.setattr(w, "get_supabase", not_activated)
    with pytest.raises(SupabaseNotConfigured):
        await w.connect_when_online(settings)
