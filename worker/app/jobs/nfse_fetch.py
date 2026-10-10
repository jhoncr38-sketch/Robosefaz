"""Busca de NFS-e Nacional (tarefa NFSE_FETCH, desde a 1.2.36).

Sem navegador: consulta a API de distribuição do ADN com o certificado do cliente (repositório do
Windows) a partir do último NSU lido, separa as notas em prestadas e tomadas por competência e grava
um ZIP por mês e tipo na pasta das notas, como os do SIAT ("EMPRESA - NFS-e tomadas - 09-2026 -
CLI000006.zip").

Notas novas de um mês que já tem arquivo viram uma versão nova do ZIP com tudo (a anterior fica,
como no reagendamento forçado); nada é apagado. Os cancelamentos chegam como eventos e marcam a
nota no índice. O NSU só avança depois que os arquivos foram gravados: se algo falhar no meio, a
próxima busca relê os mesmos documentos e só grava o que ainda não está nos arquivos.
"""

from __future__ import annotations

import asyncio
import re
import tempfile
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from app.certificates.windows_store import StoreCertificate, find_in_store, list_user_certificates
from app.downloads.note_index import NoteInfo, index_download_now, parse_note_xml
from app.downloads.organizer import DownloadFolderUnavailable, DownloadOrganizer, parse_note_name
from app.jobs.base_runner import now_utc
from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode
from app.jobs.models import Certificate, Client, DocumentType, Job, Task, TaskStatus, TaskType
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger
from app.nfse.adn import AdnBatch, AdnClient, AdnDocument, parse_event
from app.utils.cnpj import extract_cnpjs, normalize_cnpj

# 40 páginas de 50 = 2.000 documentos por trabalho; o resto fica para a próxima busca
MAX_PAGES = 40
PAGE_SIZE = 50
_KEY_IN_NAME = re.compile(r"\d{50}")


def xml_name(chave: str) -> str:
    return f"NFSe {chave}.xml"


@dataclass(slots=True)
class FetchSummary:
    pages: int = 0
    documents: int = 0
    last_nsu: int = 0
    new_notes: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    canceled: int = 0
    other_cnpj: int = 0
    unreadable: int = 0
    files: list[str] = field(default_factory=list)

    def message(self) -> str:
        prest = self.new_notes.get(DocumentType.NFSE_PRESTADAS.value, 0)
        toma = self.new_notes.get(DocumentType.NFSE_TOMADAS.value, 0)
        if not (prest or toma or self.canceled):
            return "NFS-e: nenhuma nota nova."
        parts = []
        if prest:
            parts.append(f"{prest} prestada(s)")
        if toma:
            parts.append(f"{toma} tomada(s)")
        text = "NFS-e: " + (" e ".join(parts) + " nova(s)" if parts else "nenhuma nota nova")
        if self.canceled:
            text += f"; {self.canceled} cancelamento(s)"
        return text + "."


def _same_doc(a: str | None, b: str) -> bool:
    return bool(a) and normalize_cnpj(a).zfill(14) == b.zfill(14)


def classify(info: NoteInfo, client_cnpj: str) -> DocumentType | None:
    """Prestador = cliente -> prestada; tomador = cliente -> tomada; senão (intermediário, outro
    CNPJ) a nota não é gravada para este cliente."""
    if _same_doc(info.emit_doc, client_cnpj):
        return DocumentType.NFSE_PRESTADAS
    if _same_doc(info.dest_doc, client_cnpj):
        return DocumentType.NFSE_TOMADAS
    return None


def note_competence(info: NoteInfo, fallback: str) -> str:
    comp = info.competence or (info.emitida_em or "")[:7]
    return comp if re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", comp or "") else fallback


async def resolve_thumbprint(
    certificate: Certificate | None,
    client: Client,
    *,
    store_loader: Callable[[], Any] | None = None,
) -> str:
    """Impressão digital do certificado do cliente instalado NESTE Windows (pela impressão digital
    cadastrada, pelo número de série ou, se o cadastro não tem nenhum dos dois, pelo CNPJ)."""
    store: list[StoreCertificate] = await (store_loader or list_user_certificates)()
    if certificate is not None and (certificate.thumbprint or certificate.serial_number):
        match = find_in_store(store, thumbprint=certificate.thumbprint, serial_number=certificate.serial_number)
        if match is not None and match.has_private_key:
            return match.thumbprint
        raise CertificateNotInstalledError("Certificado do cliente não encontrado no Windows deste computador.")
    cnpj = normalize_cnpj(client.cnpj)
    now = now_utc()
    for c in store:
        if not c.has_private_key or (c.not_after is not None and c.not_after.timestamp() < now.timestamp()):
            continue
        if cnpj in extract_cnpjs(c.subject.replace(":", " ")):
            return c.thumbprint
    raise CertificateNotInstalledError("Nenhum certificado com o CNPJ do cliente no Windows deste computador.")


def read_zip(path: Path) -> dict[str, bytes]:
    """XMLs de um ZIP de NFS-e já gravado (nome -> conteúdo)."""
    with zipfile.ZipFile(path) as zf:
        return {i.filename: zf.read(i) for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith(".xml")}


def write_zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(files):
            zf.writestr(name, files[name])


def keys_in(files: dict[str, bytes]) -> set[str]:
    keys = set()
    for name in files:
        m = _KEY_IN_NAME.search(name)
        if m:
            keys.add(m.group(0))
    return keys


async def run_nfse_fetch(
    repo: JobRepository,
    organizer: DownloadOrganizer,
    client: Client,
    certificate: Certificate | None,
    job: Job,
    tasks: list[Task],
    reporter: JobReporter,
    logger: JobLogger,
    *,
    adn_factory: Callable[[str], AdnClient] | None = None,
    store_loader: Callable[[], Any] | None = None,
) -> None:
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.RUNNING.value, started_at=now_utc())
        task.status = TaskStatus.RUNNING

    thumbprint = await resolve_thumbprint(certificate, client, store_loader=store_loader)
    adn = (adn_factory or AdnClient)(thumbprint)
    client_cnpj = normalize_cnpj(client.cnpj)
    start = await repo.get_nfse_cursor(client.id)
    summary = FetchSummary(last_nsu=start)
    await reporter.step(JobStatus.CHECKING_PROCESSING, "Consultando a NFS-e Nacional")
    await logger.info(
        f"Consultando a NFS-e Nacional a partir do NSU {start}"
        + (" (primeira busca: traz todo o histórico disponível)." if start == 0 else "."),
        step="checking_processing",
    )

    # 1) lê as páginas (até MAX_PAGES); nada é gravado ainda
    groups: dict[tuple[str, str], dict[str, tuple[NoteInfo, AdnDocument]]] = defaultdict(dict)
    cancels: dict[str, str] = {}
    nsu = start
    while summary.pages < MAX_PAGES:
        await reporter.check_cancel()
        batch: AdnBatch = await adn.fetch(nsu)
        summary.pages += 1
        if batch.empty:
            break
        for doc in batch.documents:
            summary.documents += 1
            if doc.tipo == "EVENTO":
                event = parse_event(doc.xml)
                if event is not None and event.cancels and event.chave:
                    cancels[event.chave] = event.descricao or event.codigo
                continue
            info = parse_note_xml(doc.xml, xml_name(doc.chave))
            if info is None:
                summary.unreadable += 1
                continue
            kind = classify(info, client_cnpj)
            if kind is None:
                summary.other_cnpj += 1
                continue
            comp = note_competence(info, job.competence)
            groups[(kind.value, comp)][info.chave] = (info, doc)
        nsu = batch.last_nsu or nsu
        if len(batch.documents) < PAGE_SIZE:
            break
    summary.last_nsu = nsu

    # 2) grava um ZIP por tipo e mês (só quando há nota que ainda não está no arquivo do mês)
    if groups:
        await reporter.step(JobStatus.ORGANIZING_FILES, "Organizando arquivos")
    for (doc_type, comp), notes in sorted(groups.items()):
        await reporter.check_cancel()
        added = await _store_group(repo, organizer, client, job, doc_type, comp, notes, logger)
        if added:
            summary.new_notes[doc_type] += added
            summary.files.append(f"{doc_type}:{comp}")

    # 3) cancelamentos marcam a nota no índice (o XML da nota continua no ZIP)
    if cancels:
        summary.canceled = await repo.mark_notes_canceled(client.id, sorted(cancels))
        for chave, desc in sorted(cancels.items()):
            await logger.info(f"Evento na NFS-e {chave}: {desc}.", step="organizing_files")

    if summary.other_cnpj:
        await logger.warning(
            f"{summary.other_cnpj} documento(s) em que o cliente não é prestador nem tomador (intermediário ou "
            "outro estabelecimento) ficaram de fora.",
            step="organizing_files",
        )
    if summary.unreadable:
        await logger.warning(f"{summary.unreadable} documento(s) sem o leiaute da NFS-e Nacional foram ignorados.", step="organizing_files")

    # 4) só agora o ponto de leitura avança
    await repo.save_nfse_cursor(client.id, summary.last_nsu, summary.documents)
    more = summary.pages >= MAX_PAGES
    message = summary.message()
    if more:
        message = message[:-1] + "; há mais documentos: a próxima busca continua daqui."
    result = {
        "documents": summary.documents,
        "pages": summary.pages,
        "from_nsu": start,
        "last_nsu": summary.last_nsu,
        "new_notes": dict(summary.new_notes),
        "canceled": summary.canceled,
        "other_cnpj": summary.other_cnpj,
        "more": more,
    }
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc(), result=result)
        task.status = TaskStatus.COMPLETED
    await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)
    await logger.info(f"{message} ({summary.documents} documento(s) lido(s); NSU {start} -> {summary.last_nsu}).", step="completed")


def _previous_zip(
    organizer: DownloadOrganizer, row: dict[str, Any] | None, client: Client, comp: str, doc_type: str, name: str
) -> Path | None:
    """A versão mais recente do ZIP do mês neste computador: a do registro do download e, se ele já foi
    apagado pela limpeza (60 dias) ou é de outro computador, a de maior número na pasta do mês."""
    if row is not None:
        path = organizer.locate(row["filepath"], client.client_code, comp, doc_type, row["filename"])
        if path.is_file():
            return path
    folder = organizer.folder_for(client.client_code, comp, doc_type, name)
    if not folder.is_dir():
        return None
    versions = [
        (note.sequence, f)
        for f in folder.glob("*.zip")
        if (note := parse_note_name(f.name)) is not None and note.client_code == client.client_code and note.competence == comp
    ]
    return max(versions)[1] if versions else None


async def _store_group(
    repo: JobRepository,
    organizer: DownloadOrganizer,
    client: Client,
    job: Job,
    doc_type: str,
    comp: str,
    notes: dict[str, tuple[NoteInfo, AdnDocument]],
    logger: JobLogger,
) -> int:
    """Grava a versão nova do ZIP do mês (anterior + notas novas). -> quantas notas novas entraram."""
    previous: dict[str, bytes] = {}
    name = client.trade_name or client.legal_name
    row = await repo.latest_download(client.id, comp, doc_type)
    try:
        prev_path = await asyncio.to_thread(_previous_zip, organizer, row, client, comp, doc_type, name)
        if prev_path is not None:
            previous = await asyncio.to_thread(read_zip, prev_path)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        await logger.warning(f"Não foi possível ler o arquivo anterior de {comp}: {exc}", step="organizing_files")
    known = keys_in(previous)
    new = {chave: item for chave, item in notes.items() if chave not in known}
    if not new:
        return 0
    files = dict(previous)
    for chave, (_info, doc) in new.items():
        files[xml_name(chave)] = doc.xml

    with tempfile.TemporaryDirectory(prefix="jr-nfse-") as tmp:
        source = Path(tmp) / f"{client.client_code}_{comp}_{doc_type}.zip"
        await asyncio.to_thread(write_zip, source, files)
        try:
            stored = await asyncio.to_thread(organizer.store, source, client.client_code, comp, doc_type, name)
        except DownloadFolderUnavailable as exc:
            raise AutomationError(ErrorCode.DOWNLOAD_FAILED, f"Pasta de downloads indisponível: {exc}", retryable=True) from exc
    if stored.saved_locally:
        await logger.warning(
            f"Pasta das notas indisponível: {stored.filename} salvo neste computador até ela voltar.", step="organizing_files"
        )

    download_task = await repo.create_task(
        job_id=job.id,
        client_id=client.id,
        task_type=TaskType.DOWNLOAD,
        competence=comp,
        status=TaskStatus.COMPLETED,
        document_type=DocumentType(doc_type),
        result={"nfse": True, **stored.model_dump(mode="json")},
    )
    row = await repo.insert_download(
        client_id=client.id,
        job_id=job.id,
        automation_task_id=download_task.id,
        document_type=doc_type,
        competence=comp,
        filename=stored.filename,
        filepath=stored.filepath,
        size=stored.size,
        checksum=stored.checksum,
        note_count=len(files),
        downloaded_at=now_utc(),
    )
    try:
        await index_download_now(repo, row, Path(stored.filepath), doc_type)
    except Exception as exc:  # noqa: BLE001 - a manutenção indexa depois
        await logger.warning(f"Não foi possível indexar as notas agora ({exc}); a manutenção fará em seguida.", step="organizing_files")
    label = "prestada(s)" if doc_type == DocumentType.NFSE_PRESTADAS.value else "tomada(s)"
    await logger.info(
        f"{stored.filename}: {len(new)} nota(s) {label} nova(s), {len(files)} no arquivo do mês {comp[5:]}/{comp[:4]}.",
        step="organizing_files",
    )
    return len(new)
