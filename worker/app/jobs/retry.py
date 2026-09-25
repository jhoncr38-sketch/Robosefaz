"""Política de retry com intervalo crescente (10s, 30s, 60s)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.jobs.errors import is_retryable


@dataclass(frozen=True, slots=True)
class RetryDecision:
    retry: bool
    delay_seconds: int = 0
    next_attempt_at: datetime | None = None
    reason: str = ""


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """`max_retries` retentativas automáticas além da primeira execução."""

    delays: tuple[int, ...] = field(default=(10, 30, 60))
    max_retries: int = 3

    def delay_for(self, retry_number: int) -> int:
        """Intervalo antes da N-ésima retentativa (1-indexado)."""
        if retry_number < 1:
            raise ValueError("retry_number começa em 1")
        idx = min(retry_number, len(self.delays)) - 1
        return self.delays[idx]

    def decide(
        self,
        error: BaseException,
        attempts_done: int,
        *,
        now: datetime | None = None,
    ) -> RetryDecision:
        """`attempts_done` = execuções já realizadas (incluindo a que falhou)."""
        if not is_retryable(error):
            return RetryDecision(False, reason="erro não permite retentativa automática")
        retry_number = attempts_done  # 1ª falha -> 1ª retentativa
        if retry_number > self.max_retries:
            return RetryDecision(False, reason=f"limite de {self.max_retries} retentativas atingido")
        delay = self.delay_for(retry_number)
        base = now or datetime.now(timezone.utc)
        return RetryDecision(
            True,
            delay_seconds=delay,
            next_attempt_at=base + timedelta(seconds=delay),
            reason=f"retentativa {retry_number}/{self.max_retries} em {delay}s",
        )
