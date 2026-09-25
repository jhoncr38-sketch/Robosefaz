"""Competência fiscal (YYYY-MM) e período correspondente."""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

_COMPETENCE_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_DISPLAY_RE = re.compile(r"^(0[1-9]|1[0-2])/(\d{4})$")


class InvalidCompetenceError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Competence:
    year: int
    month: int

    @classmethod
    def parse(cls, value: str) -> "Competence":
        value = (value or "").strip()
        m = _COMPETENCE_RE.match(value)
        if m:
            return cls(int(m.group(1)), int(m.group(2)))
        m = _DISPLAY_RE.match(value)
        if m:
            return cls(int(m.group(2)), int(m.group(1)))
        raise InvalidCompetenceError(f"Competência inválida: {value!r} (use YYYY-MM ou MM/YYYY)")

    @property
    def key(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"

    @property
    def display(self) -> str:
        return f"{self.month:02d}/{self.year:04d}"

    @property
    def start_date(self) -> date:
        return date(self.year, self.month, 1)

    @property
    def end_date(self) -> date:
        return date(self.year, self.month, calendar.monthrange(self.year, self.month)[1])

    @property
    def year_str(self) -> str:
        return f"{self.year:04d}"

    @property
    def month_str(self) -> str:
        return f"{self.month:02d}"

    def __str__(self) -> str:
        return self.key


def competence_bounds(value: str) -> tuple[date, date]:
    c = Competence.parse(value)
    return c.start_date, c.end_date


def format_br_date(d: date) -> str:
    return d.strftime("%d/%m/%Y")
