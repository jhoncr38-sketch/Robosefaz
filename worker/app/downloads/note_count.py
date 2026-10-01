"""Quantidade de notas (XMLs) dentro de cada ZIP baixado, para o painel.

Só lê o ZIP: nunca altera, move ou apaga. Roda na manutenção, fora do download, aos poucos
(20 por rodada). Qualquer problema (nota ainda subindo, arquivo em outro computador, ZIP
corrompido) só deixa aquela nota sem contar; o robô segue normalmente.
"""

from __future__ import annotations

import asyncio
import logging
import zipfile
from pathlib import Path, PureWindowsPath
from typing import Any

from app.utils.files import sha256_file

log = logging.getLogger(__name__)


def count_notes(path: Path) -> int | None:
    """XMLs dentro do ZIP (uma nota por XML). ZIP vazio = 0; sem conseguir ler = None."""
    try:
        with zipfile.ZipFile(path) as zf:
            return sum(1 for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(".xml"))
    except (OSError, zipfile.BadZipFile, ValueError):
        return None


def locate(row: dict[str, Any], base_dir: Path) -> Path | None:
    """O ZIP neste computador: o caminho gravado; se foi baixado em outro computador (ex.: o Google
    Drive em outra letra), o mesmo ano/mês/cliente/tipo/arquivo na pasta das notas daqui; e, se o
    caminho gravado é de antes de reorganizar a pasta, o arquivo do mesmo mês e tipo com o mesmo
    código de conferência (SHA-256)."""
    filepath = row.get("filepath") or ""
    candidates = [Path(filepath)] if filepath else []
    parts = PureWindowsPath(filepath).parts
    if len(parts) >= 5:
        candidates.append(base_dir.joinpath(*parts[-5:]))
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return _same_content(row, base_dir)


def _same_content(row: dict[str, Any], base_dir: Path) -> Path | None:
    year, _, month = str(row.get("competence") or "").partition("-")
    doc, size, checksum = row.get("document_type"), row.get("size"), row.get("checksum")
    if not (year and month and doc and size is not None and checksum):
        return None
    try:
        files = sorted(base_dir.glob(f"{year}/{month}/*/{doc}/*.zip"))
        for path in files:
            # o tamanho primeiro: só calcula o SHA-256 de quem pode ser
            if path.stat().st_size == size and sha256_file(path) == checksum:
                return path
    except OSError:
        return None
    return None


async def count_pending_notes(repo: Any, base_dir: Path, *, skip: set[str], limit: int = 20) -> int:
    """Conta as notas dos downloads que ainda não têm a quantidade. `skip`: os que não deu para
    ler neste computador (ficam para o próximo início do robô). Devolve quantos contou."""
    rows = await repo.list_downloads_without_note_count(min(limit + len(skip), 500))
    counted = 0
    for row in rows:
        if counted >= limit:
            break
        if row["id"] in skip:
            continue
        path = await asyncio.to_thread(locate, row, base_dir)
        count = await asyncio.to_thread(count_notes, path) if path else None
        if count is None:
            skip.add(row["id"])
            continue
        await repo.set_download_note_count(row["id"], count)
        counted += 1
    if counted:
        log.info("Quantidade de notas contada em %s download(s).", counted)
    return counted
