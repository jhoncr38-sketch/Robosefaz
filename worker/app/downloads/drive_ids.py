r"""Código (ID) das notas e das pastas no Google Drive, para os botões "Baixar" do painel.

O Google Drive para computador guarda, em %LOCALAPPDATA%\Google\DriveFS\<conta>\metadata_sqlite_db,
cada arquivo com o nome, a pasta-mãe e o ID na nuvem. O robô lê esse banco só
para leitura (nunca escreve) e grava o ID no registro do download. Enquanto o
arquivo não subiu, o ID é "local-..." e o robô tenta de novo na próxima rodada.

É um arquivo interno do Google Drive: se o formato mudar, a leitura falha em
silêncio e o painel só não mostra o botão Baixar daquela nota.

Várias contas no mesmo computador (ex.: a pessoal e a do escritório): cada uma
tem o seu banco. `probe_account` descobre de qual conta é a pasta das notas
(grava um arquivo de teste e vê em que banco ele aparece) e só essa é usada.
Se a conta ou a pasta mudar, os links antigos são apagados e refeitos na nova
(storage/drive-link.json guarda a última).
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.downloads.organizer import note_code
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


def probe_account(folder: Path, databases: list[Path], *, timeout: float = 30.0, name: str | None = None) -> Path | None:
    """Banco (conta) do Google Drive onde fica `folder`. None se não der para saber agora."""
    name = name or f"jr-sistema-conta-{uuid.uuid4().hex[:12]}.txt"
    probe = folder / name
    try:
        probe.write_text("Teste do JR Sistema Robô para saber a conta do Google Drive. Pode apagar.", encoding="utf-8")
    except OSError:
        return None
    try:
        deadline = time.monotonic() + timeout
        while True:
            for db in databases:
                try:
                    con = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=5)
                    try:
                        if con.execute("select 1 from items where local_title = ? limit 1", (name,)).fetchone():
                            return db
                    finally:
                        con.close()
                except sqlite3.Error:
                    continue
            if time.monotonic() >= deadline:
                return None
            time.sleep(1)
    finally:
        probe.unlink(missing_ok=True)


def update_link_state(state_file: Path, folder: Path, account: str) -> bool:
    """Grava a pasta/conta em uso. -> True se mudou desde a última vez (links antigos não valem mais)."""
    current = {"folder": str(folder), "account": account}
    try:
        previous = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = None
    if previous != current:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
    return isinstance(previous, dict) and previous != current


def linked_account(state_file: Path) -> str | None:
    try:
        return json.loads(state_file.read_text(encoding="utf-8")).get("account")
    except (OSError, ValueError, AttributeError):
        return None


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
            # .../2026/09/NOME DA EMPRESA/NFCE/<nota> (o código está no nome do arquivo: no início no formato
            # antigo, CLI000001_2026-09_NFCE.zip; no fim no formato com a empresa, "LIA - NFC-e - 09-2026 - CLI000001.zip")
            if titles[0] == doc and titles[2] == month and titles[3] == year and note_code(filename) == code:
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
