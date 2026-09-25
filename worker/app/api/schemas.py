"""Schemas de entrada/saída da API."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.jobs.models import EXPORT_TASK_TYPES, TaskType
from app.utils.competence import Competence


def _default_operations() -> list[TaskType]:
    return list(EXPORT_TASK_TYPES)


class _AutomationBase(BaseModel):
    competence: str
    operations: list[TaskType] = Field(default_factory=_default_operations)
    force: bool = False

    @field_validator("competence")
    @classmethod
    def _competence(cls, v: str) -> str:
        return Competence.parse(v).key

    @field_validator("operations")
    @classmethod
    def _operations(cls, v: list[TaskType]) -> list[TaskType]:
        if not v:
            raise ValueError("Informe ao menos uma operação")
        for op in v:
            if op not in EXPORT_TASK_TYPES:
                raise ValueError(f"Operação inválida: {op}")
        return list(dict.fromkeys(v))


class CreateJobsRequest(_AutomationBase):
    client_ids: list[str] = Field(min_length=1, max_length=500)
    respect_client_flags: bool = True


class ClientAutomationRequest(_AutomationBase):
    pass


class SecretRequest(BaseModel):
    secret: str = Field(min_length=1, max_length=256)


class PolicyApplyRequest(BaseModel):
    confirm: bool = False


class HealthResponse(BaseModel):
    status: str
    browser: bool
    database: bool
