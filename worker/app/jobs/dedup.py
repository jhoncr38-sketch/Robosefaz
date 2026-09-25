"""Controle de duplicidade de agendamentos.

Chave lógica: client_id + competence + document_type + operation_type.
A garantia forte está no índice único parcial do banco
(automation_tasks_dedup_active_idx); aqui ficam a mesma regra em Python
e a verificação defensiva feita pelo worker imediatamente antes de agendar.
"""

from __future__ import annotations

from typing import Protocol

from app.jobs.models import ACTIVE_TASK_STATUSES, DocumentType, Task, TaskStatus

EXPORT_OPERATION = "EXPORT"

ALREADY_SCHEDULED_STATUSES = frozenset(
    {TaskStatus.SCHEDULED, TaskStatus.PROCESSED, TaskStatus.DOWNLOADED, TaskStatus.COMPLETED}
)


def build_dedup_key(
    client_id: str, competence: str, document_type: DocumentType | str, operation_type: str = EXPORT_OPERATION
) -> str:
    return f"{client_id}|{competence}|{DocumentType(document_type).value}|{operation_type}"


class ActiveExportLookup(Protocol):
    async def find_active_export(self, dedup_key: str, exclude_task_id: str | None = None) -> Task | None: ...


def is_duplicate(existing: Task | None, *, force: bool = False) -> bool:
    if existing is None or force:
        return False
    return existing.status in ALREADY_SCHEDULED_STATUSES and not existing.superseded


def conflicts(existing: list[Task], candidate_key: str) -> list[Task]:
    """Tarefas vivas com a mesma chave (usado em testes e relatórios)."""
    return [
        t
        for t in existing
        if t.dedup_key == candidate_key and not t.superseded and t.status in ACTIVE_TASK_STATUSES
    ]


class DuplicateGuard:
    def __init__(self, lookup: ActiveExportLookup) -> None:
        self._lookup = lookup

    async def already_scheduled(self, task: Task, *, force: bool = False) -> Task | None:
        if not task.dedup_key:
            return None
        existing = await self._lookup.find_active_export(task.dedup_key, exclude_task_id=task.id)
        return existing if is_duplicate(existing, force=force) else None
