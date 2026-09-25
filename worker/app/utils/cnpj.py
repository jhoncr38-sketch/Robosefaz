"""CNPJ: normalização, validação (numérico e alfanumérico) e formatação."""

from __future__ import annotations

import re

_W1 = (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
_W2 = (6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)


def normalize_cnpj(value: str | None) -> str:
    """Remove pontuação e converte para maiúsculas (suporta CNPJ alfanumérico)."""
    return re.sub(r"[^0-9A-Za-z]", "", value or "").upper()


def _char_value(ch: str) -> int:
    return ord(ch) - 48


def _check_digit(base: str, weights: tuple[int, ...]) -> int:
    total = sum(_char_value(c) * w for c, w in zip(base, weights, strict=True))
    rest = total % 11
    return 0 if rest < 2 else 11 - rest


def validate_cnpj(value: str | None) -> bool:
    cnpj = normalize_cnpj(value)
    if len(cnpj) != 14:
        return False
    if not re.fullmatch(r"[0-9A-Z]{12}[0-9]{2}", cnpj):
        return False
    if len(set(cnpj)) == 1:
        return False
    d1 = _check_digit(cnpj[:12], _W1)
    d2 = _check_digit(cnpj[:12] + str(d1), _W2)
    return cnpj[12:] == f"{d1}{d2}"


def format_cnpj(value: str | None) -> str:
    cnpj = normalize_cnpj(value)
    if len(cnpj) != 14:
        return value or ""
    return f"{cnpj[:2]}.{cnpj[2:5]}.{cnpj[5:8]}/{cnpj[8:12]}-{cnpj[12:]}"


def cnpj_root(value: str | None) -> str:
    """Raiz do CNPJ (8 primeiros caracteres)."""
    return normalize_cnpj(value)[:8]


def extract_cnpjs(text: str | None) -> list[str]:
    """Extrai todos os CNPJs (formatados ou não) presentes em um texto livre."""
    if not text:
        return []
    found: list[str] = []
    pattern = re.compile(
        r"(?<![0-9A-Z])([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}/?[0-9A-Z]{4}-?[0-9]{2})(?![0-9A-Z])"
    )
    for match in pattern.finditer(text.upper()):
        candidate = normalize_cnpj(match.group(1))
        if validate_cnpj(candidate) and candidate not in found:
            found.append(candidate)
    return found


def same_cnpj(a: str | None, b: str | None) -> bool:
    na, nb = normalize_cnpj(a), normalize_cnpj(b)
    return bool(na) and na == nb
