"""Dono da pasta das notas: um escritório por pasta.

Dois escritórios na mesma conta do Google não podem dividir a mesma pasta: os códigos de cliente
se repetem entre escritórios (CLI000001...) e o robô de um renomearia, ligaria ao botão "Baixar"
ou contaria as notas do outro. A pasta guarda um arquivinho com o escritório dono
(`.jr-sistema-escritorio.json`); o primeiro robô que a usa marca; o robô de outro escritório
apontado para ela não grava nem mexe em nada (a nota vai para o plano B deste computador).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("downloads")

MARKER = ".jr-sistema-escritorio.json"


@dataclass(frozen=True, slots=True)
class Office:
    id: str
    name: str


class OwnerUnreadable(OSError):
    """O arquivo do dono existe mas não dá para ler (ex.: Google Drive ainda baixando)."""


def read_owner(folder: Path) -> Office | None:
    """Escritório dono da pasta; None se ainda não tem dono."""
    path = folder / MARKER
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise OwnerUnreadable(f"Não foi possível ler {path}: {exc}") from exc
    try:
        data = json.loads(raw)
        return Office(id=str(data["org_id"]), name=str(data.get("org_name") or ""))
    except (ValueError, KeyError, TypeError) as exc:
        raise OwnerUnreadable(f"Arquivo do dono da pasta inválido: {path}") from exc


def write_owner(folder: Path, office: Office, host: str = "") -> None:
    data = {
        "org_id": office.id,
        "org_name": office.name,
        "marked_by": host,
        "marked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "info": "Pasta das notas do JR Sistema deste escritório. Não apague nem copie este arquivo.",
    }
    tmp = folder / (MARKER + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, folder / MARKER)


def claim_or_check(folder: Path, office: Office, host: str = "") -> Office | None:
    """None = a pasta é deste escritório (marca agora, se ainda não tinha dono); senão, o dono."""
    owner = read_owner(folder)
    if owner is None:
        write_owner(folder, office, host)
        log.info('Pasta das notas %s marcada como do escritório "%s".', folder, office.name)
        return None
    return None if owner.id == office.id else owner


def load_office(path: Path) -> Office | None:
    """Escritório deste computador guardado pelo robô (para a ferramenta do Google Drive e sem internet)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return Office(id=str(data["org_id"]), name=str(data.get("org_name") or ""))
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_office(path: Path, office: Office) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"org_id": office.id, "org_name": office.name}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)
