"""Registro de provedores de automação (SIAT hoje; e-CAC, prefeituras... no futuro)."""

from __future__ import annotations

from typing import Callable

from app.automation.base import AutomationProvider
from app.jobs.errors import AutomationError, ErrorCode

ProviderFactory = Callable[[], AutomationProvider]


class ProviderRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, ProviderFactory] = {}

    def register(self, name: str, factory: ProviderFactory) -> None:
        self._factories[name.upper()] = factory

    def get(self, name: str) -> AutomationProvider:
        factory = self._factories.get((name or "").upper())
        if factory is None:
            raise AutomationError(ErrorCode.INVALID_CONFIGURATION, f"Provedor de automação não suportado: {name}")
        return factory()

    @property
    def names(self) -> list[str]:
        return sorted(self._factories)


def default_registry() -> ProviderRegistry:
    from app.automation.siat.provider import SiatAutomationProvider

    registry = ProviderRegistry()
    registry.register("SIAT", SiatAutomationProvider)
    return registry
