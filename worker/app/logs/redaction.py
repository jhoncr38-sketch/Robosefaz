"""Remove informações sensíveis antes de registrar logs.

Nunca registrar: senha, PIN, conteúdo privado do certificado, tokens.
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "***"

SENSITIVE_KEYS = re.compile(
    r"(password|passwd|senha|secret|token|private|pfx|p12|pkcs|authorization|cookie|credential"
    r"|(^|[_-])(pass|pin|pwd|key)($|[_-]))",
    re.IGNORECASE,
)

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), REDACTED),
    (re.compile(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", re.S), "[certificado]"),
    (re.compile(r"(?i)(senha|password|pin|pwd)\s*[:=]\s*\S+"), r"\1=" + REDACTED),
    (re.compile(r"(?i)bearer\s+[a-z0-9._\-]+"), "Bearer " + REDACTED),
    (re.compile(r"eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}"), REDACTED),
)

# Chaves que parecem sensíveis mas são metadados seguros.
_ALLOWED_KEYS = frozenset({"has_secret", "secret_backend", "key", "dedup_key", "public_key_size"})


def redact_text(text: str | None) -> str:
    if not text:
        return text or ""
    result = text
    for pattern, repl in _PATTERNS:
        result = pattern.sub(repl, result)
    return result


def redact(value: Any, _depth: int = 0) -> Any:
    if _depth > 8:
        return REDACTED
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            if key not in _ALLOWED_KEYS and SENSITIVE_KEYS.search(key):
                out[key] = REDACTED
            else:
                out[key] = redact(v, _depth + 1)
        return out
    if isinstance(value, (list, tuple, set)):
        return [redact(v, _depth + 1) for v in value]
    if isinstance(value, bytes):
        return f"<{len(value)} bytes>"
    if isinstance(value, str):
        return redact_text(value)
    return value
