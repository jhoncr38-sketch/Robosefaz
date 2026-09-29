r"""Código (ID) das notas e das pastas no Google Drive, para os botões "Baixar" do painel.

O Google Drive para computador guarda, em %LOCALAPPDATA%\Google\DriveFS\<conta>\metadata_sqlite_db,
cada arquivo com o nome, a pasta-mãe e o ID na nuvem. O robô lê esse banco só
para leitura (nunca escreve) e grava o ID no registro do download. Enquanto o
arquivo não subiu, o ID é "local-..." e o robô tenta de novo na próxima rodada.

É um arquivo interno do Google Drive: se o formato mudar, a leitura falha em
silêncio e o painel só não mostra o botão Baixar daquela nota.
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.utils.competence import Competence

log = logging.getLogger("downloads")

_CLOUD_ID = re.compile(r"^[A-Za-z0-9_-]{15,100}$")


@dataclass(frozen=True, slots=True)
class DriveIds:
    file_id: str
    client_folder_id: str  # ano/mês/cliente: "Baixar notas da LIA 08/2026"
    month_folder_id: str  # ano/mês: "Baixar todas as notas de 08/2026"


def _is_cloud_id(value: object) -> bool:
    return isinstance(value, str) and bool(_CLOUD_ID.match(value)) and not value.startswith("local-")


def drivefs_databases(local_appdata: Path | None = None) -> list[Path]:
    """Bancos de metadados do Google Drive para computador (um por conta conectada)."""
    base = local_appdata if local_appdata is not None else Path(os.environ.get("LOCALAPPDATA", ""))
    root = base / "Google" / "DriveFS"
    try:
        return sorted(p for p in root.glob("*/metadata_sqlite_db") if p.is_file())
    except OSError:
        return []


class DriveIdLookup:
    """Acha os IDs de uma nota pelo nome e pelas pastas ano/mês/cliente/tipo."""

    def __init__(self, databases: list[Path]) -> None:
        self.databases = databases

    def find(self, filename: str, client_code: str, competence: str, document_type: str) -> DriveIds | None:
        comp = Competence.parse(competence)
        expected = (document_type, client_code, comp.month_str, comp.year_str)
        for db in self.databases:
            try:
                con = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=5)
            except sqlite3.Error:
                continue
            try:
                found = self._find_in(con, filename, client_code, expected)
            except sqlite3.Error as exc:
                log.debug("Não foi possível ler %s: %s", db, exc)
                found = None
            finally:
                con.close()
            if found:
                return found
        return None

    @staticmethod
    def _parents(con: sqlite3.Connection, stable_id: Any, depth: int = 4) -> list[tuple[str, Any]]:
        """(nome, ID na nuvem) das pastas acima do arquivo, da mais próxima para a mais alta."""
        out: list[tuple[str, Any]] = []
        current = stable_id
        for _ in range(depth):
            row = con.execute(
                "select parent_stable_id from stable_parents where item_stable_id = ? limit 1", (current,)
            ).fetchone()
            if row is None:
                break
            current = row[0]
            item = con.execute("select local_title, id from items where stable_id = ?", (current,)).fetchone()
            if item is None:
                break
            out.append((str(item[0]), item[1]))
        return out

    def _find_in(
        self, con: sqlite3.Connection, filename: str, client_code: str, expected: tuple[str, str, str, str]
    ) -> DriveIds | None:
        doc, code, month, year = expected
        rows = con.execute(
            "select stable_id, id from items where local_title = ? and is_folder = 0 and trashed = 0",
            (filename,),
        ).fetchall()
        for stable_id, cloud_id in rows:
            if not _is_cloud_id(cloud_id):
                continue  # "local-...": ainda subindo
            parents = self._parents(con, stable_id)
            if len(parents) < 4:
                continue
            titles = [title for title, _ in parents]
            # .../2026/09/CLI000001 - NOME/NFCE/arquivo.zip
            client_ok = titles[1] == code or titles[1].startswith(f"{code} - ")
            if titles[0] == doc and client_ok and titles[2] == month and titles[3] == year:
                client_id, month_id = parents[1][1], parents[2][1]
                if _is_cloud_id(client_id) and _is_cloud_id(month_id):
                    return DriveIds(cloud_id, client_id, month_id)
        return None

async def link_drive_ids(repo: Any, lookup: DriveIdLookup, *, limit: int = 300) -> int:
    """Grava os IDs do Drive nos downloads que ainda não têm. Devolve quantos foram ligados."""
    import asyncio

    rows = await repo.list_downloads_without_drive_id(limit)
    linked = 0
    for row in rows:
        client_code = (row.get("clients") or {}).get("client_code") or ""
        try:
            ids = await asyncio.to_thread(lookup.find, row["filename"], client_code, row["competence"], row["document_type"])
        except (ValueError, KeyError):
            continue
        if ids:
            await repo.set_download_drive_ids(row["id"], ids.file_id, ids.client_folder_id, ids.month_folder_id)
            linked += 1
    if linked:
        log.info("%s nota(s) ligada(s) ao Google Drive (botão Baixar do painel).", linked)
    return linked
