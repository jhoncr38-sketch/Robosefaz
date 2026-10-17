"""Busca de NFS-e Nacional (tarefa NFSE_FETCH, desde a 1.2.36).

Sem navegador: consulta a API de distribuição do ADN com o certificado do cliente (repositório do
Windows) a partir do último NSU lido, separa as notas em prestadas e tomadas por competência e grava
um ZIP por mês e tipo na pasta das notas, como os do SIAT ("EMPRESA - NFS-e tomadas - 09-2026 -
CLI000006.zip").

Notas novas de um mês que já tem arquivo viram uma versão nova do ZIP com tudo (a anterior fica,
como no reagendamento forçado); nada é apagado. Os cancelamentos chegam como eventos e marcam a
nota no índice. O NSU só avança depois que os arquivos foram gravados: se algo falhar no meio, a
próxima busca relê os mesmos documentos e só grava o que ainda não está nos arquivos.

Canceladas (1.2.39): cada cancelamento também vai para um ZIP próprio do mês da nota, como no SIAT
("EMPRESA - NFS-e tomadas canceladas - 09-2026 - CLI000006.zip", pasta NFSE_TOMADAS_CANCELADAS),
com o XML da nota e o XML do evento de cancelamento. Esse ZIP não entra no índice: a nota já está
lá, marcada como cancelada, e uma linha a mais a mostraria duas vezes. "Desde o início" (pedido com
force_reschedule) relê o ADN do NSU 0 para montar os ZIPs de canceladas antigos; o que já está nos
arquivos não é gravado de novo.
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
from app.nfse.adn import AdnBatch, AdnClient, AdnDocument, arrival, parse_event
from app.utils.cnpj import extract_cnpjs, normalize_cnpj

# 40 páginas de 50 = 2.000 documentos por trabalho; o resto fica para a próxima busca
MAX_PAGES = 40
PAGE_SIZE = 50
_KEY_IN_NAME = re.compile(r"\d{50}")

# tipo da nota -> tipo do ZIP de canceladas dela
CANCELED_TYPE: dict[str, str] = {
    DocumentType.NFSE_PRESTADAS.value: DocumentType.NFSE_PRESTADAS_CANCELADAS.value,
    DocumentType.NFSE_TOMADAS.value: DocumentType.NFSE_TOMADAS_CANCELADAS.value,
}


def xml_name(chave: str) -> str:
    return f"NFSe {chave}.xml"


def event_name(chave: str, codigo: str) -> str:
    """Nome do XML do evento dentro do ZIP de canceladas (ex.: 'NFSe <chave> - evento e101101.xml')."""
    return f"NFSe {chave} - evento {codigo}.xml"


@dataclass(slots=True)
class Cancel:
    """Um evento de cancelamento lido do ADN."""

    chave: str
    codigo: str
    descricao: str
    xml: bytes


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
    canceled_files: list[str] = field(default_factory=list)

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


def note_files(files: dict[str, bytes]) -> int:
    """Quantas notas há no ZIP (os XMLs de evento não contam)."""
    return sum(1 for name in files if " - evento " not in name)


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
    # "Desde o início": relê tudo para montar os arquivos de canceladas antigos (nada é regravado)
    from_start = bool(job.force_reschedule)
    start = 0 if from_start else await repo.get_nfse_cursor(client.id)
    summary = FetchSummary(last_nsu=start)
    await reporter.step(JobStatus.CHECKING_PROCESSING, "Consultando a NFS-e Nacional")
    if from_start:
        await logger.info(
            "Relendo a NFS-e Nacional desde o início, a pedido: monta os arquivos de canceladas antigos; "
            "o que já está nos arquivos não é gravado de novo.",
            step="checking_processing",
        )
    else:
        await logger.info(
            f"Consultando a NFS-e Nacional a partir do NSU {start}"
            + (" (primeira busca: traz todo o histórico disponível)." if start == 0 else "."),
            step="checking_processing",
        )

    # 1) lê as páginas (até MAX_PAGES); nada é gravado ainda
    groups: dict[tuple[str, str], dict[str, tuple[NoteInfo, AdnDocument]]] = defaultdict(dict)
    cancels: dict[str, Cancel] = {}
    arrivals: dict[str, dict[str, Any]] = {}  # chave -> quando a nota chegou ao ambiente nacional
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
                    cancels[event.chave] = Cancel(event.chave, event.codigo, event.descricao or event.codigo, doc.xml)
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
            arrived = arrival(doc.xml, doc.gerado_em)
            if arrived is not None:
                arrivals[info.chave] = {"chave": info.chave, **arrived}
        nsu = batch.last_nsu or nsu
        if len(batch.documents) < PAGE_SIZE:
            break
    summary.last_nsu = nsu

    # 2) grava um ZIP por tipo e mês (só quando há nota que ainda não está no arquivo do mês)
    if groups or cancels:
        await reporter.step(JobStatus.ORGANIZING_FILES, "Organizando arquivos")
    for (doc_type, comp), notes in sorted(groups.items()):
        await reporter.check_cancel()
        added = await _store_group(repo, organizer, client, job, doc_type, comp, notes, logger)
        if added:
            summary.new_notes[doc_type] += added
            summary.files.append(f"{doc_type}:{comp}")

    # 2a) nota emitida pelo sistema que a prefeitura confirmou mas não devolveu: o XML que chegou agora
    #     completa o registro da emissão (é dele que o painel tira o DANFSE)
    issued = {
        chave: doc
        for (doc_type, _), notes in groups.items()
        if doc_type == DocumentType.NFSE_PRESTADAS.value
        for chave, (_, doc) in notes.items()
    }
    if issued:
        try:
            for em in await repo.emissions_missing_xml(client.id):
                doc = issued.get(em.get("chave") or "")
                if doc is not None:
                    fields: dict[str, Any] = {"nfse_xml": doc.xml.decode("utf-8", "replace")}
                    if em.get("status") == "issued":  # tira o aviso "a prefeitura ainda não devolveu o arquivo"
                        fields["last_message"] = f"NFS-e nº {em.get('numero')} emitida"
                    await repo.update_nfse_emission(em["id"], **fields)
                    await logger.info(f"Chegou o arquivo da NFS-e nº {em.get('numero')}, emitida pelo sistema.", step="organizing_files")
        except Exception:  # noqa: BLE001 - banco ainda sem a tabela de emissões, ou falha passageira: a busca não depende disso
            pass

    # 2b) hora em que cada nota chegou ao ambiente nacional (o painel avisa quando a prefeitura demora a repassar)
    if arrivals:
        try:
            await repo.set_nfse_arrivals(client.id, list(arrivals.values()))
        except Exception:  # noqa: BLE001 - banco ainda sem essa função, ou falha passageira: a busca não depende disso
            pass

    # 3) cancelamentos marcam a nota no índice (o XML da nota continua no ZIP do mês)...
    if cancels:
        summary.canceled = await repo.mark_notes_canceled(client.id, sorted(cancels))
        try:
            await repo.mark_emissions_canceled(client.id, sorted(cancels))
        except Exception:  # noqa: BLE001 - banco ainda sem a tabela de emissões: o índice já foi marcado
            pass
        for chave, ev in sorted(cancels.items()):
            await logger.info(f"Evento na NFS-e {chave}: {ev.descricao}.", step="organizing_files")
        # ...e vão, com o XML do evento, para o ZIP de canceladas do mês da nota
        await _store_canceled(repo, organizer, client, job, groups, cancels, summary, logger)

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
        "from_start": from_start,
        "last_nsu": summary.last_nsu,
        "new_notes": dict(summary.new_notes),
        "canceled": summary.canceled,
        "canceled_files": summary.canceled_files,
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


async def _read_previous(
    repo: JobRepository, organizer: DownloadOrganizer, client: Client, comp: str, doc_type: str, logger: JobLogger
) -> dict[str, bytes]:
    """XMLs já gravados no ZIP mais recente do mês e tipo (vazio se não há arquivo)."""
    name = client.trade_name or client.legal_name
    row = await repo.latest_download(client.id, comp, doc_type)
    try:
        prev_path = await asyncio.to_thread(_previous_zip, organizer, row, client, comp, doc_type, name)
        if prev_path is not None:
            return await asyncio.to_thread(read_zip, prev_path)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        await logger.warning(f"Não foi possível ler o arquivo anterior de {comp}: {exc}", step="organizing_files")
    return {}


async def _store_zip(
    repo: JobRepository,
    organizer: DownloadOrganizer,
    client: Client,
    job: Job,
    doc_type: str,
    comp: str,
    files: dict[str, bytes],
    logger: JobLogger,
    *,
    index: bool,
    extra: dict[str, Any] | None = None,
) -> Any:
    """Grava a versão nova do ZIP do mês e registra o download. `index`: notas entram no índice agora;
    o ZIP de canceladas de NFS-e não é indexado (a nota já está no índice, marcada)."""
    name = client.trade_name or client.legal_name
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
        result={"nfse": True, **(extra or {}), **stored.model_dump(mode="json")},
    )
    fields: dict[str, Any] = {
        "client_id": client.id,
        "job_id": job.id,
        "automation_task_id": download_task.id,
        "document_type": doc_type,
        "competence": comp,
        "filename": stored.filename,
        "filepath": stored.filepath,
        "size": stored.size,
        "checksum": stored.checksum,
        "note_count": note_files(files),
        "downloaded_at": now_utc(),
    }
    if not index:
        fields["notes_indexed_at"] = now_utc()  # a manutenção não deve indexar este ZIP
    row = await repo.insert_download(**fields)
    if index:
        try:
            await index_download_now(repo, row, Path(stored.filepath), doc_type)
        except Exception as exc:  # noqa: BLE001 - a manutenção indexa depois
            await logger.warning(f"Não foi possível indexar as notas agora ({exc}); a manutenção fará em seguida.", step="organizing_files")
    return stored


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
    previous = await _read_previous(repo, organizer, client, comp, doc_type, logger)
    known = keys_in(previous)
    new = {chave: item for chave, item in notes.items() if chave not in known}
    if not new:
        return 0
    files = dict(previous)
    for chave, (_info, doc) in new.items():
        files[xml_name(chave)] = doc.xml
    stored = await _store_zip(repo, organizer, client, job, doc_type, comp, files, logger, index=True)
    label = "prestada(s)" if doc_type == DocumentType.NFSE_PRESTADAS.value else "tomada(s)"
    await logger.info(
        f"{stored.filename}: {len(new)} nota(s) {label} nova(s), {len(files)} no arquivo do mês {comp[5:]}/{comp[:4]}.",
        step="organizing_files",
    )
    return len(new)


async def _locate_canceled(
    repo: JobRepository,
    groups: dict[tuple[str, str], dict[str, tuple[NoteInfo, AdnDocument]]],
    cancels: dict[str, Cancel],
    client: Client,
) -> dict[str, tuple[str, str]]:
    """Em que ZIP do mês cada nota cancelada está: (tipo da nota, competência). Primeiro pelas notas lidas
    nesta busca, depois pelo índice. Nota desconhecida (de outro CNPJ, por exemplo) fica de fora."""
    where: dict[str, tuple[str, str]] = {}
    for (doc_type, comp), notes in groups.items():
        for chave in notes:
            if chave in cancels:
                where[chave] = (doc_type, comp)
    missing = [chave for chave in cancels if chave not in where]
    if missing:
        for row in await repo.list_notes_by_chave(client.id, missing):
            doc_type = str(row.get("document_type") or "")
            comp = str(row.get("competence") or "")
            if doc_type in CANCELED_TYPE and re.fullmatch(r"\d{4}-\d{2}", comp):
                where[str(row["chave"])] = (doc_type, comp)
    return where


async def _store_canceled(
    repo: JobRepository,
    organizer: DownloadOrganizer,
    client: Client,
    job: Job,
    groups: dict[tuple[str, str], dict[str, tuple[NoteInfo, AdnDocument]]],
    cancels: dict[str, Cancel],
    summary: FetchSummary,
    logger: JobLogger,
) -> None:
    """Um ZIP de canceladas por mês e tipo, com o XML da nota e o XML do evento; só o que ainda não está lá."""
    where = await _locate_canceled(repo, groups, cancels, client)
    unknown = sorted(set(cancels) - set(where))
    if unknown:
        await logger.info(
            f"{len(unknown)} cancelamento(s) de nota que não é deste cliente (ou ainda não baixada) ficaram só no histórico.",
            step="organizing_files",
        )
    by_zip: dict[tuple[str, str], list[str]] = defaultdict(list)
    for chave, (doc_type, comp) in where.items():
        by_zip[(CANCELED_TYPE[doc_type], comp)].append(chave)

    for (canceled_type, comp), chaves in sorted(by_zip.items()):
        base_type = next(k for k, v in CANCELED_TYPE.items() if v == canceled_type)
        previous = await _read_previous(repo, organizer, client, comp, canceled_type, logger)
        month_zip: dict[str, bytes] | None = None  # XMLs do ZIP normal do mês, lidos só se precisar
        files = dict(previous)
        new = 0
        for chave in sorted(chaves):
            ev = cancels[chave]
            if event_name(chave, ev.codigo) in previous:
                continue  # este cancelamento já está no arquivo
            files[event_name(chave, ev.codigo)] = ev.xml
            new += 1
            if xml_name(chave) in files:
                continue
            batch_note = groups.get((base_type, comp), {}).get(chave)
            if batch_note is not None:
                files[xml_name(chave)] = batch_note[1].xml
                continue
            if month_zip is None:
                month_zip = await _read_previous(repo, organizer, client, comp, base_type, logger)
            if xml_name(chave) in month_zip:
                files[xml_name(chave)] = month_zip[xml_name(chave)]
        if not new:
            continue
        stored = await _store_zip(
            repo, organizer, client, job, canceled_type, comp, files, logger, index=False, extra={"canceled": True}
        )
        summary.canceled_files.append(f"{canceled_type}:{comp}")
        label = "prestada(s)" if base_type == DocumentType.NFSE_PRESTADAS.value else "tomada(s)"
        await logger.info(
            f"{stored.filename}: {new} cancelamento(s) novo(s) de nota(s) {label}, {note_files(files)} nota(s) no "
            f"arquivo de canceladas do mês {comp[5:]}/{comp[:4]}.",
            step="organizing_files",
        )
