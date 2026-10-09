"""Pausa automática da conferência rápida (1.2.35).

A conferência rápida espera até alguns minutos depois de agendar para já baixar o que ficou pronto.
Num dia em que a SEFAZ está lenta, essa espera não traz nada e só segura o robô em cada cliente.
O robô percebe sozinho: se nos últimos clientes nada ficou pronto na hora, ele pula a espera nos
próximos por um tempo; quando a pausa acaba, o próximo cliente serve de teste: se algo ficar
pronto, volta ao normal; se não, pausa de novo.

O estado é deste robô (memória do processo): cada computador decide pelo que ele mesmo viu.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class QuickCheckGovernor:
    # clientes seguidos sem nada pronto na hora para pausar
    misses_to_pause: int = 3
    # duração da pausa (segundos)
    pause_seconds: float = 30 * 60
    misses: int = 0
    paused_until: float = 0.0
    # depois de uma pausa, o próximo cliente é um teste: um só "nada pronto" já pausa de novo
    probing: bool = False

    def should_run(self, now: float) -> bool:
        return now >= self.paused_until

    def remaining_seconds(self, now: float) -> float:
        return max(0.0, self.paused_until - now)

    def record(self, found: bool, now: float) -> bool:
        """Resultado de uma conferência rápida (`found`: algo ficou pronto ou foi resolvido).
        True = começou uma pausa agora."""
        if found:
            self.misses = 0
            self.probing = False
            return False
        self.misses += 1
        if self.probing or self.misses >= self.misses_to_pause:
            self.misses = 0
            self.probing = True
            self.paused_until = now + self.pause_seconds
            return True
        return False
