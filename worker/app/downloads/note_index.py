"""Índice das notas (XMLs) dentro dos ZIPs e o XML sob demanda, para o painel ("Notas" / "ver a nota").

Só lê os ZIPs: nunca altera, move ou apaga. O índice roda na manutenção, aos poucos (50 ZIPs por
rodada); o XML pedido pelo painel sai num laço leve a cada 5 s. Problema num ZIP (corrompido, ainda
subindo, em outro computador) só deixa aquele de fora; o robô segue normalmente.
"""

from __future__ import annotations

import asyncio
import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.downloads.note_count import locate

log = logging.getLogger(__name__)

_KEY = re.compile(r"\d{44}")
# XML maior que isso não é nota (uma NF-e grande tem ~100 KB)
_MAX_XML_BYTES = 5 * 1024 * 1024


@dataclass(slots=True)
class NoteInfo:
    chave: str
    modelo: int | None
    serie: int | None
    numero: int | None
    emitida_em: str | None
    valor: str | None  # decimal como texto (sem arredondar em float)
    emit_doc: str | None
    emit_nome: str | None
    emit_uf: str | None
    dest_doc: str | None
    dest_nome: str | None
    dest_uf: str | None
    cstat: str | None
    xml_name: str


def _text(el: ET.Element | None, path: str) -> str | None:
    if el is None:
        return None
    found = el.find(path)
    if found is None or found.text is None:
        return None
    value = found.text.strip()
    return value or None


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _doc(el: ET.Element | None) -> str | None:
    return _text(el, "{*}CNPJ") or _text(el, "{*}CPF") or _text(el, "{*}idEstrangeiro")


def parse_note_xml(data: bytes, xml_name: str = "") -> NoteInfo | None:
    """Dados principais de uma NF-e/NFC-e (nfeProc ou NFe solta). None se não for uma nota."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return None
    inf = root.find(".//{*}infNFe")
    if inf is None:
        return None
    chave = (inf.get("Id") or "")[-44:]
    if not _KEY.fullmatch(chave):
        m = _KEY.search(xml_name)
        if not m:
            return None
        chave = m.group(0)
    ide = inf.find("{*}ide")
    emit = inf.find("{*}emit")
    dest = inf.find("{*}dest")
    total = inf.find(".//{*}ICMSTot")
    emitted = _text(ide, "{*}dhEmi") or _text(ide, "{*}dEmi")
    return NoteInfo(
        chave=chave,
        modelo=_int(_text(ide, "{*}mod")),
        serie=_int(_text(ide, "{*}serie")),
        numero=_int(_text(ide, "{*}nNF")),
        emitida_em=emitted,
        valor=_text(total, "{*}vNF"),
        emit_doc=_doc(emit),
        emit_nome=_text(emit, "{*}xNome"),
        emit_uf=_text(emit, ".//{*}UF"),
        dest_doc=_doc(dest),
        dest_nome=_text(dest, "{*}xNome"),
        dest_uf=_text(dest, ".//{*}UF"),
        cstat=_text(root, ".//{*}protNFe//{*}cStat"),
        xml_name=xml_name,
    )


def index_zip(path: Path) -> list[NoteInfo] | None:
    """Notas dentro do ZIP (uma por XML). None se o ZIP não puder ser lido."""
    notes: list[NoteInfo] = []
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir() or not info.filename.lower().endswith(".xml") or info.file_size > _MAX_XML_BYTES:
                    continue
                note = parse_note_xml(zf.read(info), info.filename)
                if note is not None:
                    notes.append(note)
    except (OSError, zipfile.BadZipFile, ValueError):
        return None
    return notes


def note_rows(download: dict[str, Any], zip_path: Path, notes: list[NoteInfo]) -> list[dict[str, Any]]:
    """Linhas da tabela notes para um ZIP (a mesma chave duas vezes no ZIP: fica a última)."""
    doc = str(download["document_type"])
    by_key: dict[str, dict[str, Any]] = {}
    for n in notes:
        by_key[n.chave] = {
            "client_id": download["client_id"],
            "download_id": download["id"],
            "document_type": doc,
            "competence": download["competence"],
            "canceled": doc.endswith("_CANCELADAS"),
            "zip_path": str(zip_path),
            **asdict(n),
        }
    return list(by_key.values())


async def index_download_now(repo: Any, download_row: dict[str, Any], path: Path, document_type: str) -> int | None:
    """Nota pela chave: lê o ZIP recém-gravado e põe a(s) nota(s) no índice na hora, sem esperar a
    manutenção (quem pediu está olhando a tela Notas). Devolve quantas notas há no arquivo; None
    se não deu para ler ou se a linha do download não tem id."""
    notes = await asyncio.to_thread(index_zip, path)
    if notes is None or not download_row.get("id"):
        return None
    row = {**download_row, "document_type": document_type}
    if notes:
        await repo.upsert_notes(note_rows(row, path, notes))
    await repo.set_download_notes_indexed(row["id"], len(notes))
    return len(notes)


async def index_pending_notes(repo: Any, base_dir: Path, *, skip: set[str], limit: int = 50) -> int:
    """Indexa os downloads que ainda não foram lidos. `skip`: ZIPs que não deu para ler neste
    computador (ficam para o próximo início do robô). Devolve quantos ZIPs indexou."""
    rows = await repo.list_downloads_to_index(min(limit + len(skip), 500))
    done = 0
    for row in rows:
        if done >= limit:
            break
        if row["id"] in skip:
            continue
        path = await asyncio.to_thread(locate, row, base_dir)
        notes = await asyncio.to_thread(index_zip, path) if path else None
        if notes is None or path is None:
            skip.add(row["id"])
            continue
        if notes:
            await repo.upsert_notes(note_rows(row, path, notes))
        await repo.set_download_notes_indexed(row["id"], len(notes))
        done += 1
    if done:
        log.info("Notas indexadas em %s download(s).", done)
    return done


def read_note_xml(path: Path, xml_name: str, chave: str) -> str | None:
    """O XML de uma nota dentro do ZIP (pelo nome gravado ou, se mudou, pela chave no nome)."""
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            name = xml_name if xml_name in names else next((n for n in names if chave in n and n.lower().endswith(".xml")), None)
            if name is None:
                return None
            data = zf.read(name)
    except (OSError, zipfile.BadZipFile, ValueError, KeyError):
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


async def serve_note_xml_requests(repo: Any, base_dir: Path, *, skip: set[tuple[str, str]], limit: int = 5) -> int:
    """Entrega o XML das notas que o painel pediu ("ver a nota"). Se o ZIP não está neste computador,
    deixa o pedido para outro robô (e não tenta de novo até o painel pedir outra vez)."""
    rows = await repo.list_note_xml_requests(limit + len(skip))
    served = 0
    for row in rows:
        key = (row["id"], str(row.get("xml_requested_at")))
        if key in skip:
            continue
        download = row.get("downloads") or {}
        locator = {**download, "filepath": download.get("filepath") or row["zip_path"]}
        path = await asyncio.to_thread(locate, locator, base_dir)
        if path is None:
            skip.add(key)
            continue
        xml = await asyncio.to_thread(read_note_xml, path, row["xml_name"], row["chave"])
        if xml is None:
            await repo.set_note_xml(row["id"], None, "O XML desta nota não está mais dentro do ZIP.")
        else:
            await repo.set_note_xml(row["id"], xml, None)
        served += 1
    return served
