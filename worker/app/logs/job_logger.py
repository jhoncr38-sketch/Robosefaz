"""Logger de jobs: grava em automation_logs e no log local, sempre redigido."""

from __future__ import annotations

import logging
import sys
from typing import TYPE_CHECKING, Any

from app.jobs.models import LogLevel
from app.logs.redaction import redact, redact_text

if TYPE_CHECKING:
    from app.jobs.repository import JobRepository

_PY_LEVEL = {
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.WARNING: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
}


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(getattr(h, "_siat", False) for h in root.handlers):
        root.setLevel(level.upper())
        return
    handler = logging.StreamHandler(sys.stdout)
    handler._siat = True  # type: ignore[attr-defined]
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(level.upper())
    for noisy in ("httpx", "httpcore", "hpack", "postgrest", "supabase"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class JobLogger:
    def __init__(self, repo: "JobRepository", job_id: str | None, *, task_id: str | None = None) -> None:
        self._repo = repo
        self.job_id = job_id
        self.task_id = task_id
        self._log = logging.getLogger(f"job.{job_id[:8] if job_id else 'system'}")

    def for_task(self, task_id: str | None) -> "JobLogger":
        return JobLogger(self._repo, self.job_id, task_id=task_id)

    async def log(
        self,
        level: LogLevel,
        message: str,
        *,
        step: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        safe_message = redact_text(message)
        safe_meta = redact(metadata or {})
        self._log.log(_PY_LEVEL[level], "[%s] %s", step or "-", safe_message)
        try:
            await self._repo.add_log(
                job_id=self.job_id,
                task_id=self.task_id,
                level=level,
                step=step,
                message=safe_message,
                metadata=safe_meta,
            )
        except Exception as exc:  # log nunca deve derrubar a automação
            self._log.warning("Falha ao gravar log no banco: %s", exc)

    async def debug(self, message: str, **kw: Any) -> None:
        await self.log(LogLevel.DEBUG, message, **kw)

    async def info(self, message: str, **kw: Any) -> None:
        await self.log(LogLevel.INFO, message, **kw)

    async def warning(self, message: str, **kw: Any) -> None:
        await self.log(LogLevel.WARNING, message, **kw)

    async def error(self, message: str, **kw: Any) -> None:
        await self.log(LogLevel.ERROR, message, **kw)
