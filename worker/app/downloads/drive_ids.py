r"""Código (ID) das notas no Google Drive, para o botão "Baixar" do painel.

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
from pathlib import Path
from typing import Any

from app.utils.competence import Competence

log = logging.getLogger("downloads")

_CLOUD_ID = re.compile(r"^[A-Za-z0-9_-]{20,100}$")


def drivefs_databases(local_appdata: Path | None = None) -> list[Path]:
    """Bancos de metadados do Google Drive para computador (um por conta conectada)."""
    base = local_appdata if local_appdata is not None else Path(os.environ.get("LOCALAPPDATA", ""))
    root = base / "Google" / "DriveFS"
    try:
        return sorted(p for p in root.glob("*/metadata_sqlite_db") if p.is_file())
    except OSError:
        return []


class DriveIdLookup:
    """Acha o ID de uma nota pelo nome e pelas pastas cliente/ano/mês/tipo."""

    def __init__(self, databases: list[Path]) -> None:
        self.databases = databases

    def find(self, filename: str, client_code: str, competence: str, document_type: str) -> str | None:
        comp = Competence.parse(competence)
        expected = (document_type, comp.month_str, comp.year_str)
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
    def _parents(con: sqlite3.Connection, stable_id: Any, depth: int = 4) -> list[str]:
        titles: list[str] = []
        current = stable_id
        for _ in range(depth):
            row = con.execute(
                "select parent_stable_id from stable_parents where item_stable_id = ? limit 1", (current,)
            ).fetchone()
            if row is None:
                break
            current = row[0]
            title = con.execute("select local_title from items where stable_id = ?", (current,)).fetchone()
            if title is None:
                break
            titles.append(str(title[0]))
        return titles

    def _find_in(
        self, con: sqlite3.Connection, filename: str, client_code: str, expected: tuple[str, str, str]
    ) -> str | None:
        rows = con.execute(
            "select stable_id, id from items where local_title = ? and is_folder = 0 and trashed = 0",
            (filename,),
        ).fetchall()
        for stable_id, cloud_id in rows:
            if not isinstance(cloud_id, str) or not _CLOUD_ID.match(cloud_id):
                continue  # "local-...": ainda subindo
            parents = self._parents(con, stable_id)
            # .../CLI000001 - NOME/2026/09/NFCE/arquivo.zip
            if tuple(parents[:3]) == expected and len(parents) > 3 and parents[3].startswith(client_code):
                return cloud_id
        return None


async def link_drive_ids(repo: Any, lookup: DriveIdLookup, *, limit: int = 300) -> int:
    """Grava o ID do Drive nos downloads que ainda não têm. Devolve quantos foram ligados."""
    import asyncio

    rows = await repo.list_downloads_without_drive_id(limit)
    linked = 0
    for row in rows:
        client_code = (row.get("clients") or {}).get("client_code") or ""
        try:
            drive_id = await asyncio.to_thread(
                lookup.find, row["filename"], client_code, row["competence"], row["document_type"]
            )
        except (ValueError, KeyError):
            continue
        if drive_id:
            await repo.set_download_drive_id(row["id"], drive_id)
            linked += 1
    if linked:
        log.info("%s nota(s) ligada(s) ao Google Drive (botão Baixar do painel).", linked)
    return linked
