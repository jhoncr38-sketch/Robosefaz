"""Recuperação de jobs de um robô que parou de repente (PC desligado, queda de energia).

Cada robô avisa "estou vivo" a cada 30 s (worker_heartbeats). Se o dono de um
job não avisa há mais de `dead_after_s` (padrão 3 min), qualquer outro robô
ligado libera o job, sem esperar o lock vencer:

- cancelado pelo usuário enquanto o dono estava fora -> fica CANCELADO;
- agendamentos já feitos no SIAT (só falta consultar/baixar) -> volta para
  "Aguardando SEFAZ" com consulta imediata (nada é reagendado);
- ainda faltava agendar -> volta para a fila (ou falha, se esgotou as tentativas).

Também libera o lock que um robô VIVO esqueceu (status "idle" com lock antigo) e,
no próprio robô, o job que ficou com o lock dele sem nenhum runner trabalhando
nele (ex.: a internet caiu na hora de gravar o fim e o lock ficou para trás).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from collections.abc import Collection
from typing import Any

from app.jobs.models import LogLevel, TaskStatus, TaskType
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus

log = logging.getLogger("recovery")

_OPEN_EXPORT = {TaskStatus.PENDING, TaskStatus.RUNNING}
_WAITING_SEFAZ = {TaskStatus.SCHEDULED, TaskStatus.PROCESSED}

# Textos por motivo: dono desligado (outro robô assume) ou preso no próprio robô.
_GONE = {
    "cancel": ("Cancelado pelo usuário (o robô que executava foi desligado).",
               "Robô que executava foi desligado; cancelamento concluído."),
    "wait": ("O robô que executava foi desligado; outro robô continua a consulta.",
             "Robô que executava foi desligado; consulta retomada (nada foi reagendado)."),
    "fail": ("Robô desligado durante a execução.", "Robô que executava foi desligado; tentativas esgotadas."),
    "fail_error": "O robô foi desligado durante a execução e as tentativas se esgotaram.",
    "queue": ("O robô que executava foi desligado; job devolvido à fila.",
              "Robô que executava foi desligado; job devolvido à fila."),
}
_STUCK = {
    "cancel": ("Cancelado pelo usuário (a conexão caiu durante a execução).",
               "Trabalho tinha ficado preso neste robô (queda de conexão); cancelamento concluído."),
    "wait": ("A conexão caiu durante a execução; a consulta continua.",
             "Trabalho tinha ficado preso neste robô (queda de conexão); consulta retomada (nada foi reagendado)."),
    "fail": ("Conexão perdida durante a execução.",
             "Trabalho tinha ficado preso neste robô (queda de conexão); tentativas esgotadas."),
    "fail_error": "A conexão caiu durante a execução e as tentativas se esgotaram.",
    "queue": ("A conexão caiu durante a execução; trabalho devolvido à fila.",
              "Trabalho tinha ficado preso neste robô (queda de conexão); devolvido à fila."),
}


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


def own_lock_is_stuck(job: dict[str, Any], active: Collection[str], now: datetime, *, grace_s: int) -> bool:
    """Lock deste robô sem runner nenhum no job. A carência cobre o instante entre o banco
    entregar o job (claim) e o runner registrá-lo como em andamento."""
    if job["id"] in active:
        return False
    locked_at = _parse(job.get("locked_at"))
    return locked_at is not None and (now - locked_at).total_seconds() > grace_s


async def recover_orphaned_jobs(
    repo: JobRepository,
    own_worker_id: str,
    *,
    dead_after_s: int = 180,
    stale_minutes: int = 45,
    own_active: Collection[str] | None = None,
    own_grace_s: int = 120,
    now: datetime | None = None,
) -> list[str]:
    """`own_active`: ids que os runners deste robô estão processando agora (None = não olha
    os próprios locks)."""
    now = now or datetime.now(timezone.utc)
    heartbeats = await repo.list_heartbeats()
    recovered: list[str] = []
    for job in await repo.list_locked_jobs():
        owner = job["locked_by"]
        own = owner == own_worker_id
        if own:
            if own_active is None or not own_lock_is_stuck(job, own_active, now, grace_s=own_grace_s):
                continue
        elif not owner_is_gone(job, heartbeats, now, dead_after_s=dead_after_s, stale_minutes=stale_minutes):
            continue
        text = _STUCK if own else _GONE
        tasks = await repo.list_tasks(job["id"])
        exports = [t for t in tasks if t.is_export and not t.superseded]

        if job.get("cancel_requested"):
            fields: dict[str, Any] = {
                "status": JobStatus.CANCELLED.value,
                "current_step": JobStatus.CANCELLED.value,
                "finished_at": now,
                "last_message": text["cancel"][0],
            }
            message = text["cancel"][1]
        elif exports and not any(t.status in _OPEN_EXPORT for t in exports):
            fields = {
                "status": JobStatus.WAITING_SEFAZ.value,
                "current_step": JobStatus.WAITING_SEFAZ.value,
                "progress": 80,
                "next_check_at": now,
                "last_message": text["wait"][0],
            }
            message = text["wait"][1]
        elif job.get("attempts", 0) > job.get("max_attempts", 0):
            fields = {
                "status": JobStatus.FAILED.value,
                "current_step": JobStatus.FAILED.value,
                "finished_at": now,
                "error_code": "WORKER_LOST",
                "error_message": text["fail_error"],
                "last_message": text["fail"][0],
            }
            message = text["fail"][1]
        else:
            fields = {
                "status": JobStatus.QUEUED.value,
                "current_step": JobStatus.QUEUED.value,
                "next_attempt_at": now,
                "last_message": text["queue"][0],
            }
            message = text["queue"][1]
        fields.update(locked_by=None, locked_at=None)

        if own and job["id"] in own_active:  # type: ignore[operator]
            continue  # um runner pegou o job enquanto as tarefas eram lidas
        if not await repo.update_job_if_locked_by(job["id"], owner, **fields):
            continue  # outro robô já cuidou deste job
        for t in tasks:
            if job.get("cancel_requested") and t.status in (_OPEN_EXPORT | _WAITING_SEFAZ):
                await repo.update_task(t.id, status=TaskStatus.CANCELLED.value, finished_at=now)
            elif t.status == TaskStatus.RUNNING:
                # exportação que não chegou a ser enviada (ou consulta de EFD, que só lê) volta a pendente;
                # consulta/download interrompido falha
                read_only = t.task_type in (TaskType.EFD_CHECK, TaskType.MALHA_CHECK)
                status = TaskStatus.PENDING if t.is_export or read_only else TaskStatus.FAILED
                await repo.update_task(t.id, status=status.value)
        await repo.add_log(
            job_id=job["id"], task_id=None, level=LogLevel.WARNING, step="recovery",
            message=f"{message} (robô{'' if own else ' anterior'}: {owner})", metadata={},
        )
        log.warning("Job %s recuperado do robô %s%s: %s", job["id"], owner, " (este)" if own else "", fields["status"])
        recovered.append(job["id"])
    return recovered
