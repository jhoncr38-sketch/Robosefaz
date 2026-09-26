"""Limpeza automática (retenção).

Decisão do produto: o histórico no Supabase só interessa por RETENTION_DAYS
(padrão 60) dias contados da data do download. Depois disso são apagados:

- no Supabase: registros de downloads, jobs finalizados (tarefas e logs vão
  junto por cascata), notificações e a auditoria de downloads/jobs;
- neste computador: os prints de etapas e de erros do robô.

Os ZIPs baixados NUNCA são apagados pelo robô: ficam na pasta de downloads de
cada computador até o próprio usuário apagar.

Antes disso: logs DEBUG somem em RETENTION_DEBUG_LOG_DAYS (7) e registros de
robôs desligados em RETENTION_HEARTBEAT_DAYS (7).

Nunca apaga: clientes, certificados, usuários e a auditoria de segurança
(cadastros e alterações), nem jobs ainda em andamento.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, fields
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import Settings
from app.jobs.repository import JobRepository

log = logging.getLogger("retention")

FINISHED_JOB_STATUSES = ["completed", "failed", "cancelled", "manual_action_required", "certificate_required"]
# auditoria que é "histórico de automação"; o resto (clientes, certificados, usuários) fica
HISTORY_AUDIT_ENTITIES = ["download", "automation_job"]

_SHOT_SUFFIXES = {".png", ".jpg", ".jpeg"}


@dataclass
class RetentionReport:
    screenshots: int = 0
    downloads: int = 0
    jobs: int = 0
    logs: int = 0
    heartbeats: int = 0
    notifications: int = 0
    audit: int = 0

    @property
    def total(self) -> int:
        return sum(getattr(self, f.name) for f in fields(self))

    def summary(self) -> str:
        parts = {
            "prints": self.screenshots,
            "registros de download": self.downloads,
            "jobs": self.jobs,
            "logs": self.logs,
            "heartbeats": self.heartbeats,
            "notificações": self.notifications,
            "auditoria": self.audit,
        }
        return ", ".join(f"{v} {k}" for k, v in parts.items() if v)


def _remove_empty_dirs(base: Path) -> None:
    for d in sorted((p for p in base.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            d.rmdir()  # só remove se estiver vazia
        except OSError:
            pass


def sweep_screenshots(base: Path, cutoff: datetime) -> int:
    """Apaga prints do robô (png/jpg) modificados antes de `cutoff`."""
    if not base.is_dir():
        return 0
    removed = 0
    for path in base.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in _SHOT_SUFFIXES:
            continue
        try:
            if datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc) < cutoff:
                path.unlink()
                removed += 1
        except OSError as exc:
            log.warning("Não foi possível apagar %s: %s", path, exc)
    _remove_empty_dirs(base)
    return removed


class RetentionService:
    def __init__(self, repo: JobRepository, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings

    async def run(self, now: datetime | None = None) -> RetentionReport:
        report = RetentionReport()
        days = self.settings.retention_days
        if days <= 0:
            return report
        now = now or datetime.now(timezone.utc)
        cutoff = now - timedelta(days=days)

        # 1. prints do robô neste computador (os ZIPs ficam)
        for folder in (self.settings.screenshots_dir, self.settings.errors_dir):
            report.screenshots += await asyncio.to_thread(sweep_screenshots, folder, cutoff)

        # 2. registros de download no Supabase
        while True:
            rows = await self.repo.list_downloads_before(cutoff)
            if not rows:
                break
            deleted = await self.repo.delete_rows("downloads", [r["id"] for r in rows])
            report.downloads += deleted
            if deleted == 0 or len(rows) < 500:
                break

        # 3. jobs finalizados (tarefas e logs vão junto)
        report.jobs = await self.repo.delete_jobs_finished_before(cutoff, FINISHED_JOB_STATUSES)

        # 4. logs soltos, notificações, auditoria de automação, heartbeats
        debug_cutoff = now - timedelta(days=max(0, self.settings.retention_debug_log_days))
        report.logs += await self.repo.delete_older_than(
            "automation_logs", "created_at", debug_cutoff, eq={"level": "DEBUG"}
        )
        report.logs += await self.repo.delete_older_than("automation_logs", "created_at", cutoff)
        report.notifications = await self.repo.delete_older_than("notifications", "created_at", cutoff)
        report.audit = await self.repo.delete_older_than(
            "audit_logs", "created_at", cutoff, in_={"entity": HISTORY_AUDIT_ENTITIES}
        )
        hb_cutoff = now - timedelta(days=max(1, self.settings.retention_heartbeat_days))
        report.heartbeats = await self.repo.delete_older_than("worker_heartbeats", "last_seen_at", hb_cutoff)

        if report.total:
            log.info("Limpeza automática (%s dias): %s", days, report.summary())
        return report
