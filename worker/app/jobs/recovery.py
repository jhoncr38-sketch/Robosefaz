"""Recuperação de jobs de um robô que parou de repente (PC desligado, queda de energia).

Cada robô avisa "estou vivo" a cada 30 s (worker_heartbeats). Se o dono de um
job não avisa há mais de `dead_after_s` (padrão 3 min), qualquer outro robô
ligado libera o job, sem esperar o lock vencer:

- cancelado pelo usuário enquanto o dono estava fora -> fica CANCELADO;
- agendamentos já feitos no SIAT (só falta consultar/baixar) -> volta para
  "Aguardando SEFAZ" com consulta imediata (nada é reagendado);
- ainda faltava agendar -> volta para a fila (ou falha, se esgotou as tentativas).

Também libera o lock que um robô VIVO esqueceu (status "idle" com lock antigo).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.jobs.models import LogLevel, TaskStatus
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus

log = logging.getLogger("recovery")

_OPEN_EXPORT = {TaskStatus.PENDING, TaskStatus.RUNNING}
_WAITING_SEFAZ = {TaskStatus.SCHEDULED, TaskStatus.PROCESSED}


def _parse(value: str | datetime | None) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def owner_is_gone(
    job: dict[str, Any], heartbeats: dict[str, dict[str, Any]], now: datetime, *, dead_after_s: int, stale_minutes: int
) -> bool:
    hb = heartbeats.get(job["locked_by"])
    if hb is None or hb.get("status") == "stopped":
        return True
    last = _parse(hb.get("last_seen_at"))
    if last is None or (now - last).total_seconds() > dead_after_s:
        return True
    # robô vivo e parado, mas com lock antigo: lock esquecido
    locked_at = _parse(job.get("locked_at"))
    return hb.get("status") == "idle" and locked_at is not None and now - locked_at > timedelta(minutes=stale_minutes)


async def recover_orphaned_jobs(
    repo: JobRepository,
    own_worker_id: str,
    *,
    dead_after_s: int = 180,
    stale_minutes: int = 45,
    now: datetime | None = None,
) -> list[str]:
    now = now or datetime.now(timezone.utc)
    heartbeats = await repo.list_heartbeats()
    recovered: list[str] = []
    for job in await repo.list_locked_jobs():
        owner = job["locked_by"]
        if owner == own_worker_id:
            continue
        if not owner_is_gone(job, heartbeats, now, dead_after_s=dead_after_s, stale_minutes=stale_minutes):
            continue
        tasks = await repo.list_tasks(job["id"])
        exports = [t for t in tasks if t.is_export and not t.superseded]

        if job.get("cancel_requested"):
            fields: dict[str, Any] = {
                "status": JobStatus.CANCELLED.value,
                "current_step": JobStatus.CANCELLED.value,
                "finished_at": now,
                "last_message": "Cancelado pelo usuário (o robô que executava foi desligado).",
            }
            message = "Robô que executava foi desligado; cancelamento concluído."
        elif exports and not any(t.status in _OPEN_EXPORT for t in exports):
            fields = {
                "status": JobStatus.WAITING_SEFAZ.value,
                "current_step": JobStatus.WAITING_SEFAZ.value,
                "progress": 80,
                "next_check_at": now,
                "last_message": "O robô que executava foi desligado; outro robô continua a consulta.",
            }
            message = "Robô que executava foi desligado; consulta retomada (nada foi reagendado)."
        elif job.get("attempts", 0) > job.get("max_attempts", 0):
            fields = {
                "status": JobStatus.FAILED.value,
                "current_step": JobStatus.FAILED.value,
                "finished_at": now,
                "error_code": "WORKER_LOST",
                "error_message": "O robô foi desligado durante a execução e as tentativas se esgotaram.",
                "last_message": "Robô desligado durante a execução.",
            }
            message = "Robô que executava foi desligado; tentativas esgotadas."
        else:
            fields = {
                "status": JobStatus.QUEUED.value,
                "current_step": JobStatus.QUEUED.value,
                "next_attempt_at": now,
                "last_message": "O robô que executava foi desligado; job devolvido à fila.",
            }
            message = "Robô que executava foi desligado; job devolvido à fila."
        fields.update(locked_by=None, locked_at=None)

        if not await repo.update_job_if_locked_by(job["id"], owner, **fields):
            continue  # outro robô já cuidou deste job
        for t in tasks:
            if job.get("cancel_requested") and t.status in (_OPEN_EXPORT | _WAITING_SEFAZ):
                await repo.update_task(t.id, status=TaskStatus.CANCELLED.value, finished_at=now)
            elif t.status == TaskStatus.RUNNING:
                # exportação que não chegou a ser enviada volta a pendente; consulta/download interrompido falha
                status = TaskStatus.PENDING if t.is_export else TaskStatus.FAILED
                await repo.update_task(t.id, status=status.value)
        await repo.add_log(
            job_id=job["id"], task_id=None, level=LogLevel.WARNING, step="recovery",
            message=f"{message} (robô anterior: {owner})", metadata={},
        )
        log.warning("Job %s recuperado do robô %s: %s", job["id"], owner, fields["status"])
        recovered.append(job["id"])
    return recovered
