"""Emissão e cancelamento de NFS-e pela API da prefeitura (tarefas NFSE_EMIT e NFSE_CANCEL, desde a 1.2.37).

Sem navegador. O painel grava em nfse_emissions o que a pessoa conferiu e confirmou; o robô monta a
DPS copiando de notas reais do cliente o que não pode ser inventado (ver app.nfse.dps), assina com o
certificado dele no Windows e envia à prefeitura. O robô nunca emite por conta própria: só executa
um pedido confirmado, uma nota por trabalho.

Nunca duas notas para o mesmo pedido: o número da DPS é reservado no banco antes do envio, e todo
recomeço (falha de rede, robô reiniciado, Reprocessar) primeiro pergunta à prefeitura se aquela DPS
já virou nota. Se virou, a nota é recuperada em vez de enviada de novo. Nota que a prefeitura confirma
mas não consegue devolver (a consulta pela chave falha em nota com dados de obra) fica registrada como
emitida do mesmo jeito, com o número tirado da chave; o XML dela entra depois, pela busca de NFS-e.

A nota emitida fica no registro do pedido (para o painel mostrar o DANFSE na hora) e, em produção,
entra no ZIP de NFS-e prestadas do mês na pasta das notas, como as que o robô baixa. No ambiente de
teste da prefeitura nada vai para a pasta: a nota não tem valor fiscal.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from decimal import Decimal
from typing import Any

from app.downloads.note_count import locate
from app.downloads.note_index import parse_note_xml, read_note_xml
from app.downloads.organizer import DownloadOrganizer
from app.jobs.base_runner import now_utc
from app.jobs.errors import AutomationError, ErrorCode
from app.jobs.models import Certificate, Client, DocumentType, Job, Task, TaskStatus
from app.jobs.nfse_fetch import _store_group, note_competence, resolve_thumbprint, xml_name
from app.jobs.reporter import JobReporter
from app.jobs.repository import JobRepository
from app.jobs.state_machine import JobStatus
from app.logs.job_logger import JobLogger
from app.nfse.adn import AdnDocument
from app.nfse.dps import API_SERIE, DpsRequest, build_cancel, build_dps, dps_id, key_number, note_key, tag
from app.nfse.prefeitura import ApiResult, PrefeituraClient
from app.nfse.signer import sign_xml
from app.utils.cnpj import normalize_cnpj

# números de DPS já usados fora do sistema (testes, outro programa) são pulados, até este limite
MAX_NUMBER_TRIES = 30
# resposta real da prefeitura ao cancelar duas vezes: "Nota fiscal não está ativa. Situação atual Cancelada"
_ALREADY_CANCELED = re.compile(r"situa[cç][aã]o atual\s+cancelad|j[aá]\b.{0,40}cancelad", re.I)

ApiFactory = Callable[..., PrefeituraClient]
Signer = Callable[[str, str, str], Awaitable[bytes]]


def money(value: Any) -> str:
    inteiro, _, cent = f"{Decimal(str(value)):,.2f}".partition(".")
    return "R$ " + inteiro.replace(",", ".") + "," + cent


async def load_note_xml(repo: JobRepository, organizer: DownloadOrganizer, client_id: str, chave: str, what: str) -> str:
    """XML de uma nota do cliente, lido do ZIP na pasta das notas deste computador."""
    row = await repo.get_note_file(client_id, chave)
    if row is None:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, f"A {what} não está mais no índice das notas.")
    download = row.get("downloads") or {}
    locator = {**download, "filepath": download.get("filepath") or row.get("zip_path")}
    path = await asyncio.to_thread(locate, locator, organizer.base_dir)
    xml = await asyncio.to_thread(read_note_xml, path, row.get("xml_name") or "", chave) if path else None
    if xml is None:
        raise AutomationError(
            ErrorCode.INVALID_CONFIGURATION,
            f"O arquivo da {what} não está na pasta das notas deste computador (final da chave {chave[-8:]}).",
        )
    return xml


async def _complete(repo: JobRepository, tasks: list[Task], reporter: JobReporter, message: str, result: dict[str, Any]) -> None:
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.COMPLETED.value, finished_at=now_utc(), result=result)
        task.status = TaskStatus.COMPLETED
    await reporter.set_final(JobStatus.COMPLETED, finished_at=now_utc(), last_message=message)


async def _issued_xml(api: PrefeituraClient, chave: str, logger: JobLogger) -> bytes | None:
    """XML de uma nota que já existe na prefeitura; None quando a consulta dela falha.

    A consulta pela chave nem sempre funciona: em nota com dados de obra a prefeitura responde erro interno
    (L9999). A nota existe do mesmo jeito, então a falha não pode derrubar a emissão: o pedido é registrado
    como emitido sem o arquivo, e o arquivo chega depois pela busca de NFS-e."""
    try:
        return await api.get_nfse(chave)
    except AutomationError as exc:
        await logger.warning(
            f"A nota existe na prefeitura (chave {chave}), mas a consulta dela falhou: {exc.message}", step="checking_processing"
        )
        return None


def _rejection(result: ApiResult, what: str) -> AutomationError:
    first = result.errors[0]
    return AutomationError(
        ErrorCode.NFSE_REJECTED,
        f"A prefeitura recusou {what}: {first['mensagem']}" + (f" ({first['codigo']})" if first["codigo"] else ""),
        metadata={"errors": result.errors},
    )


async def run_nfse_emit(
    repo: JobRepository,
    organizer: DownloadOrganizer,
    client: Client,
    certificate: Certificate | None,
    job: Job,
    tasks: list[Task],
    reporter: JobReporter,
    logger: JobLogger,
    *,
    api_factory: ApiFactory | None = None,
    signer: Signer | None = None,
    store_loader: Callable[[], Any] | None = None,
) -> None:
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.RUNNING.value, started_at=now_utc())
        task.status = TaskStatus.RUNNING

    em = await repo.begin_nfse_emission(job.id)
    if em is None:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Pedido de emissão não encontrado para este trabalho.")
    emission_id = em["id"]
    test_env = bool(em.get("test_env"))
    suffix = " (ambiente de teste)" if test_env else ""
    if em["status"] in ("issued", "canceled"):
        message = f"NFS-e nº {em.get('numero')} já estava emitida{suffix}."
        await _complete(repo, tasks, reporter, message, {"chave": em.get("chave"), "numero": em.get("numero"), "already": True})
        return

    cnpj = normalize_cnpj(client.cnpj)
    thumbprint = await resolve_thumbprint(certificate, client, store_loader=store_loader)
    api = (api_factory or PrefeituraClient)(thumbprint, test_env=test_env)
    steps = dict(em.get("steps") or {})
    numero = int(em["n_dps"])
    await reporter.step(JobStatus.CHECKING_PROCESSING, "Preparando a NFS-e")

    # 1) o número da DPS: se esta DPS já saiu numa tentativa anterior, a nota existe e é recuperada;
    #    se o número foi usado fora do sistema, pula para o próximo
    sent_before = bool(em.get("send_started_at")) and bool(em.get("id_dps"))
    chave: str | None = None
    ident = dps_id(cnpj, numero)
    for _ in range(MAX_NUMBER_TRIES):
        ident = dps_id(cnpj, numero)
        chave = await api.find_by_dps(ident)
        if chave is None or (sent_before and em.get("id_dps") == ident):
            break
        await logger.info(f"O número {numero} da série {API_SERIE} já foi usado na prefeitura; usando o próximo.", step="checking_processing")
        numero = await repo.bump_nfse_number(emission_id)
        chave = None
    else:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Não foi possível achar um número de DPS livre na prefeitura.")

    nfse_bytes: bytes | None = None
    recovered = chave is not None
    if recovered:
        await logger.warning(
            f"A DPS {numero} já tinha virado nota numa tentativa anterior; recuperando a nota em vez de enviar de novo.",
            step="checking_processing",
        )
        nfse_bytes = await _issued_xml(api, chave, logger)
    else:
        # 2) monta com o que foi conferido no painel + o que vem das notas reais do cliente
        model_xml = await load_note_xml(repo, organizer, client.id, em["model_chave"], "nota-modelo")
        prest_xml = model_xml
        latest = await repo.latest_emit_model(client.id)
        if latest is not None and latest.get("chave") != em["model_chave"]:
            try:
                prest_xml = await load_note_xml(repo, organizer, client.id, latest["chave"], "nota mais recente")
            except AutomationError:
                prest_xml = model_xml
        taker_xml = None
        if em.get("toma_chave"):
            taker_xml = await load_note_xml(repo, organizer, client.id, em["toma_chave"], "nota do tomador")
        xml, ident = build_dps(
            DpsRequest(
                cnpj=cnpj,
                numero=numero,
                amount=Decimal(str(em["amount"])),
                description=em["description"],
                competence=em["competence"],
                model_xml=model_xml,
                prest_xml=prest_xml,
                taker_xml=taker_xml,
                taker=em.get("toma") if isinstance(em.get("toma"), dict) else None,
                test_env=test_env,
                # o que a pessoa conferiu no painel: atividade informada à mão, NBS e IBS/CBS
                c_trib_nac=em["c_trib_nac"] if em.get("custom_service") else None,
                c_trib_mun=em["c_trib_mun"] if em.get("custom_service") else None,
                c_nbs=em.get("c_nbs"),
                ibs=None
                if em.get("ibs_cst") is None
                else {"cst": em.get("ibs_cst") or "", "class_trib": em.get("ibs_class_trib") or "", "ind_op": em.get("ibs_ind_op") or ""},
            )
        )
        signed = await (signer or sign_xml)(xml, thumbprint, "infDPS")
        steps["signed_at"] = now_utc().isoformat()
        await reporter.check_cancel()  # última chance de desistir: depois do envio só o cancelamento da nota

        # 3) reserva (a DPS está saindo) e envia
        sent_at = now_utc()
        steps["sent_at"] = sent_at.isoformat()
        await repo.update_nfse_emission(
            emission_id, id_dps=ident, send_started_at=sent_at, steps=steps, last_message="Enviada à prefeitura; aguardando a resposta"
        )
        await reporter.step(JobStatus.CHECKING_PROCESSING, "Enviando a NFS-e à prefeitura")
        await logger.info(f"Enviando a DPS {numero} (série {API_SERIE}) à prefeitura{suffix}.", step="checking_processing")
        result = await api.emit(signed)
        nfse_bytes = result.xml_bytes("nfseXmlGZipB64") if result.status in (200, 201) else None
        chave = result.chave or (note_key(nfse_bytes.decode("utf-8", "replace")) if nfse_bytes else None)
        if nfse_bytes is None or chave is None:
            # sem a nota inteira na resposta: antes de decidir, pergunta se a DPS virou nota
            # (se a resposta já trouxe a chave, a nota existe e a pergunta é dispensada)
            if chave is None:
                try:
                    chave = await api.find_by_dps(ident)
                except AutomationError:
                    chave = None
            if chave is not None:
                nfse_bytes = nfse_bytes or await _issued_xml(api, chave, logger)
            elif result.status == 400 and result.errors:
                # recusa de negócio: nada foi emitido e o número volta a ficar livre
                await repo.update_nfse_emission(
                    emission_id, status="rejected", errors=result.errors, n_dps=None, id_dps=None, send_started_at=None,
                    last_message="A prefeitura recusou a nota",
                )
                for e in result.errors:
                    await logger.warning(f"Prefeitura {e['codigo']}: {e['mensagem']}", step="checking_processing")
                raise _rejection(result, "a nota")
            else:
                await repo.update_nfse_emission(emission_id, last_message="Sem confirmação da prefeitura; o robô vai conferir de novo")
                raise AutomationError(
                    ErrorCode.NFSE_UNAVAILABLE,
                    f"A prefeitura não confirmou a emissão ({result.summary}). Nada foi reenviado: a próxima tentativa confere primeiro se a nota saiu.",
                    retryable=True,
                )

    if chave is None:
        raise AutomationError(
            ErrorCode.NFSE_UNAVAILABLE, "A prefeitura não confirmou a emissão; o robô vai conferir de novo.", retryable=True
        )

    # 4) nota emitida: registra primeiro (é o que importa), depois guarda na pasta. Sem o XML (a consulta
    #    da prefeitura falhou), o número sai da própria chave e o arquivo chega pela busca de NFS-e
    nfse_xml = nfse_bytes.decode("utf-8", "replace") if nfse_bytes else None
    numero_nfse = (tag("nNFSe", nfse_xml) if nfse_xml else "") or key_number(chave)
    steps["issued_at"] = now_utc().isoformat()
    taker_name = em.get("toma_nome") or "tomador não identificado"
    message = f"NFS-e nº {numero_nfse} emitida: {money(em['amount'])} para {taker_name}{suffix}."
    note = f"NFS-e nº {numero_nfse} emitida" + (" (recuperada)" if recovered else "")
    fields: dict[str, Any] = {} if nfse_xml is None else {"nfse_xml": nfse_xml}
    if nfse_xml is None:
        if test_env:
            waiting = "a prefeitura não devolveu o arquivo da nota"
        else:
            waiting = "a prefeitura ainda não devolveu o arquivo da nota; a próxima busca de NFS-e traz"
        message += f" Atenção: {waiting}."
        note += f"; {waiting}"
    await repo.update_nfse_emission(
        emission_id,
        status="issued",
        chave=chave,
        numero=int(numero_nfse) if numero_nfse.isdigit() else None,
        issued_at=now_utc(),
        id_dps=ident,
        n_dps=numero,
        steps=steps,
        errors=[],
        last_message=note,
        **fields,
    )
    await logger.info(message + f" Chave {chave}.", step="checking_processing")

    if not test_env and nfse_bytes:
        try:
            info = parse_note_xml(nfse_bytes, xml_name(chave))
            if info is not None:
                await reporter.step(JobStatus.ORGANIZING_FILES, "Guardando a nota na pasta")
                comp = note_competence(info, job.competence)
                doc = AdnDocument(nsu=0, chave=chave, tipo="NFSE", xml=nfse_bytes)
                await _store_group(repo, organizer, client, job, DocumentType.NFSE_PRESTADAS.value, comp, {chave: (info, doc)}, logger)
        except Exception as exc:  # noqa: BLE001 - a nota já existe e está no registro; a busca de NFS-e traz o arquivo depois
            await logger.warning(
                f"A nota foi emitida, mas não deu para guardá-la na pasta agora ({exc}); a próxima busca de NFS-e traz o arquivo.",
                step="organizing_files",
            )

    await _complete(
        repo, tasks, reporter, message,
        {
            "chave": chave, "numero": numero_nfse, "serie": API_SERIE, "n_dps": numero, "test_env": test_env,
            "recovered": recovered, "xml_pending": nfse_xml is None,
        },
    )


async def run_nfse_cancel(
    repo: JobRepository,
    client: Client,
    certificate: Certificate | None,
    job: Job,
    tasks: list[Task],
    reporter: JobReporter,
    logger: JobLogger,
    *,
    api_factory: ApiFactory | None = None,
    signer: Signer | None = None,
    store_loader: Callable[[], Any] | None = None,
) -> None:
    for task in tasks:
        await repo.update_task(task.id, status=TaskStatus.RUNNING.value, started_at=now_utc())
        task.status = TaskStatus.RUNNING

    em = await repo.get_nfse_emission_to_cancel(job.id)
    if em is None:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Pedido de cancelamento não encontrado para este trabalho.")
    emission_id, chave = em["id"], em.get("chave")
    test_env = bool(em.get("test_env"))
    suffix = " (ambiente de teste)" if test_env else ""
    done = f"NFS-e nº {em.get('numero')} cancelada{suffix}."
    if em["status"] == "canceled":
        await _complete(repo, tasks, reporter, done, {"chave": chave, "already": True})
        return
    if em["status"] != "issued" or not chave:
        raise AutomationError(ErrorCode.INVALID_CONFIGURATION, "Só dá para cancelar uma nota emitida.")

    thumbprint = await resolve_thumbprint(certificate, client, store_loader=store_loader)
    api = (api_factory or PrefeituraClient)(thumbprint, test_env=test_env)
    await repo.update_nfse_emission(emission_id, cancel_status="processing")
    xml = build_cancel(
        chave, normalize_cnpj(client.cnpj), int(em.get("cancel_reason_code") or 0), em.get("cancel_reason") or "", test_env=test_env
    )
    signed = await (signer or sign_xml)(xml, thumbprint, "infPedReg")
    await reporter.check_cancel()
    await reporter.step(JobStatus.CHECKING_PROCESSING, "Cancelando a NFS-e na prefeitura")
    await logger.info(f"Enviando o cancelamento da NFS-e nº {em.get('numero')} à prefeitura{suffix}.", step="checking_processing")
    result = await api.register_event(chave, signed)

    accepted = result.status in (200, 201) and result.xml("eventoXmlGZipB64") is not None
    # um reenvio depois de falha de rede encontra a nota já cancelada: o resultado é o mesmo
    already = result.status == 400 and any(_ALREADY_CANCELED.search(e["mensagem"]) for e in result.errors)
    if accepted or already:
        await repo.update_nfse_emission(
            emission_id, status="canceled", canceled_at=now_utc(), cancel_status=None, cancel_errors=[], last_message="Nota cancelada"
        )
        if not test_env:
            await repo.mark_notes_canceled(client.id, [chave])
        await logger.info(done, step="checking_processing")
        await _complete(repo, tasks, reporter, done, {"chave": chave, "already": already})
        return
    if result.status == 400 and result.errors:
        await repo.update_nfse_emission(emission_id, cancel_status="rejected", cancel_errors=result.errors)
        for e in result.errors:
            await logger.warning(f"Prefeitura {e['codigo']}: {e['mensagem']}", step="checking_processing")
        raise _rejection(result, "o cancelamento")
    raise AutomationError(
        ErrorCode.NFSE_UNAVAILABLE, f"A prefeitura não confirmou o cancelamento ({result.summary}).", retryable=True
    )
