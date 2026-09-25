"""Consulta (somente leitura) ao repositório de certificados do Windows."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime

_PS_SCRIPT = (
    "Get-ChildItem Cert:\\CurrentUser\\My | "
    "Select-Object Subject, Issuer, Thumbprint, SerialNumber, HasPrivateKey, "
    "@{n='NotBefore';e={$_.NotBefore.ToString('o')}}, @{n='NotAfter';e={$_.NotAfter.ToString('o')}} | "
    "ConvertTo-Json -Compress"
)


@dataclass(slots=True)
class StoreCertificate:
    subject: str
    issuer: str
    thumbprint: str
    serial_number: str
    has_private_key: bool
    not_before: datetime | None
    not_after: datetime | None


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _list_sync() -> list[StoreCertificate]:
    if sys.platform != "win32":
        return []
    proc = subprocess.run(  # noqa: S603
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _PS_SCRIPT],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return []
    raw = json.loads(proc.stdout)
    if isinstance(raw, dict):
        raw = [raw]
    return [
        StoreCertificate(
            subject=r.get("Subject") or "",
            issuer=r.get("Issuer") or "",
            thumbprint=(r.get("Thumbprint") or "").upper(),
            serial_number=(r.get("SerialNumber") or "").upper(),
            has_private_key=bool(r.get("HasPrivateKey")),
            not_before=_parse_dt(r.get("NotBefore")),
            not_after=_parse_dt(r.get("NotAfter")),
        )
        for r in raw
    ]


async def list_user_certificates() -> list[StoreCertificate]:
    return await asyncio.to_thread(_list_sync)


def _norm_serial(value: str | None) -> str:
    return (value or "").replace(" ", "").replace(":", "").upper().lstrip("0")


def find_in_store(
    certs: list[StoreCertificate], *, thumbprint: str | None, serial_number: str | None
) -> StoreCertificate | None:
    tp = (thumbprint or "").replace(" ", "").upper()
    sn = _norm_serial(serial_number)
    for c in certs:
        if tp and c.thumbprint == tp:
            return c
        if sn and _norm_serial(c.serial_number) == sn:
            return c
    return None
