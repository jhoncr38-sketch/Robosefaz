"""Leitura das mensagens "EPE - EFD" do Domicílio Tributário Eletrônico (DT-e) do SIAT.

A SEFAZ-PI envia uma NOTIFICAÇÃO para cada EFD recebida da Receita Federal:

    Número do EPE: 93104981381
    Data Processamento: 11/09/2026 18:09:48
    Tipo de Arquivo: EFD
    Inscrição Estadual: 19.603.499-0
    CNPJ/CPF: 28100366000151
    Razão Social: C BEZERRA MARCENARIA LTDA
    Período de Referência: 08/2026
    Finalidade: ORIGINAL | RETIFICADORA
    Data Recebimento: 11/09/2026 17:19:31

    Informamos que a sua declaração ... FOI PROCESSADA | NÃO FOI PROCESSADA na nossa base de dados.

    Inconsistência(s) - Tipo| Regra| Local | Detalhamento
    Inconsistência Tipo 3 - Alerta
    4.1.03 - Escrituração - Registro C100 - Malha EFD NF-e Entradas não Registradas ...

    Observações:
    Legenda dos tipos de Inconsistências: (Tipo 1 impeditiva, 2 pendência, 3 alerta)

Este módulo só interpreta texto (sem navegador), para ser testado com mensagens reais.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from enum import StrEnum

from pydantic import BaseModel, Field

# horário de Brasília (o SIAT mostra datas sem fuso)
BRT = timezone(timedelta(hours=-3))

SUBJECT_RE = re.compile(r"EPE\s*-\s*EFD\s*-\s*Per[íi]odo\s*(\d{4})(\d{2})\s*-\s*(\d+)", re.IGNORECASE)

_FIELD = r"^\s*{label}\s*:\s*(.+?)\s*$"
_FIELDS = {
    "epe_number": r"n[úu]mero\s+do\s+epe",
    "processed_at": r"data\s+(?:de\s+)?processamento",
    "file_type": r"tipo\s+de\s+arquivo",
    "state_registration": r"inscri[çc][ãa]o\s+estadual",
    "cnpj": r"cnpj\s*/\s*cpf",
    "legal_name": r"raz[ãa]o\s+social",
    "period": r"per[íi]odo\s+de\s+refer[êe]ncia",
    "finalidade": r"finalidade",
    "received_at": r"data\s+(?:de\s+)?recebimento",
}

NOT_PROCESSED_RE = re.compile(r"n[ãa]o\s+foi\s+processad[ao]", re.IGNORECASE)
PROCESSED_RE = re.compile(r"foi\s+processad[ao]", re.IGNORECASE)
INCONSISTENCY_HEADER_RE = re.compile(r"inconsist[êe]ncia\(s\)\s*-\s*tipo", re.IGNORECASE)
INCONSISTENCY_TYPE_RE = re.compile(r"^\s*inconsist[êe]ncia\s+tipo\s+(\d)\s*(?:-\s*(.+?))?\s*$", re.IGNORECASE)
RULE_RE = re.compile(r"^\s*(\d+(?:\.\d+)+)\s*-\s*(.+?)\s*$")
END_OF_INCONSISTENCIES_RE = re.compile(r"^\s*(observa[çc][õo]es|legenda\s+dos\s+tipos)\b", re.IGNORECASE)

TYPE_LABEL = {1: "Impeditiva", 2: "Pendência", 3: "Alerta"}


class EfdSituation(StrEnum):
    """Situação da declaração, do pior para o melhor."""

    NOT_PROCESSED = "not_processed"  # "NÃO FOI PROCESSADA" (inconsistência tipo 1, impeditiva)
    PENDING = "pending"  # processada com pendência (tipo 2): regularizar em até 45 dias
    ALERT = "alert"  # processada com alerta/malha fiscal (tipo 3)
    PROCESSED = "processed"  # processada sem inconsistências


class EfdInconsistency(BaseModel):
    type: int
    type_label: str
    rule: str
    description: str


class EfdMessage(BaseModel):
    epe_number: str
    competence: str | None = None  # AAAA-MM
    finalidade: str | None = None  # ORIGINAL / RETIFICADORA
    file_type: str | None = None
    state_registration: str | None = None  # só dígitos
    cnpj: str | None = None  # só dígitos
    legal_name: str | None = None
    processed: bool | None = None
    processed_at: datetime | None = None
    received_at: datetime | None = None
    inconsistencies: list[EfdInconsistency] = Field(default_factory=list)
    raw_text: str = ""

    @property
    def situation(self) -> EfdSituation:
        types = {i.type for i in self.inconsistencies}
        if self.processed is False or 1 in types:
            return EfdSituation.NOT_PROCESSED
        if 2 in types:
            return EfdSituation.PENDING
        if 3 in types:
            return EfdSituation.ALERT
        return EfdSituation.PROCESSED


def parse_subject(subject: str) -> tuple[str, str] | None:
    """"EPE - EFD - Período 202608 - 93104981381" -> ("2026-08", "93104981381")."""
    m = SUBJECT_RE.search(subject or "")
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2)}", m.group(3)


def _datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(value.strip(), fmt).replace(tzinfo=BRT)
        except ValueError:
            continue
    return None


def _digits(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"\D", "", value) or None


def _competence(value: str | None) -> str | None:
    m = re.search(r"(\d{2})\s*/\s*(\d{4})", value or "")
    return f"{m.group(2)}-{m.group(1)}" if m else None


def _parse_inconsistencies(lines: list[str]) -> list[EfdInconsistency]:
    out: list[EfdInconsistency] = []
    inside = False
    current_type: int | None = None
    for line in lines:
        if INCONSISTENCY_HEADER_RE.search(line):
            inside = True
            continue
        if not inside:
            continue
        if END_OF_INCONSISTENCIES_RE.search(line):
            break
        if not line.strip():
            continue
        m = INCONSISTENCY_TYPE_RE.match(line)
        if m:
            current_type = int(m.group(1))
            continue
        r = RULE_RE.match(line)
        if r and current_type is not None:
            out.append(
                EfdInconsistency(
                    type=current_type,
                    type_label=TYPE_LABEL.get(current_type, f"Tipo {current_type}"),
                    rule=r.group(1),
                    description=r.group(2),
                )
            )
            continue
        if out:
            # detalhamento que quebrou em mais de uma linha
            out[-1].description = f"{out[-1].description} {line.strip()}"
    return out


def parse_message(text: str) -> EfdMessage | None:
    """Interpreta o texto da mensagem; None se não for uma notificação de EFD."""
    values: dict[str, str] = {}
    for key, label in _FIELDS.items():
        m = re.search(_FIELD.format(label=label), text, re.IGNORECASE | re.MULTILINE)
        if m:
            values[key] = m.group(1)
    epe = _digits(values.get("epe_number"))
    if not epe:
        return None

    processed: bool | None = None
    if NOT_PROCESSED_RE.search(text):
        processed = False
    elif PROCESSED_RE.search(text):
        processed = True

    finalidade = values.get("finalidade")
    return EfdMessage(
        epe_number=epe,
        competence=_competence(values.get("period")),
        finalidade=finalidade.strip().upper() if finalidade else None,
        file_type=(values.get("file_type") or "").strip() or None,
        state_registration=_digits(values.get("state_registration")),
        cnpj=_digits(values.get("cnpj")),
        legal_name=(values.get("legal_name") or "").strip() or None,
        processed=processed,
        processed_at=_datetime(values.get("processed_at")),
        received_at=_datetime(values.get("received_at")),
        inconsistencies=_parse_inconsistencies(text.splitlines()),
        raw_text=text.strip(),
    )


def latest(messages: list[EfdMessage]) -> EfdMessage | None:
    """Declaração que vale para a competência: a processada por último (retificadora substitui a original)."""
    if not messages:
        return None
    return max(
        messages,
        key=lambda m: (m.processed_at or m.received_at or datetime.min.replace(tzinfo=BRT), m.epe_number),
    )
