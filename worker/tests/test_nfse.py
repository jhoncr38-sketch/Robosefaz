"""NFS-e Nacional (tarefa NFSE_FETCH): leitura da API do ADN simulada, notas fictícias."""

from __future__ import annotations

import base64
import gzip
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.certificates.windows_store import StoreCertificate
from app.downloads.note_index import index_pending_notes, parse_note_xml
from app.jobs import nfse_fetch
from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode
from app.jobs.models import TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from app.nfse.adn import NO_DOCUMENTS, AdnBatch, AdnClient, AdnDocument, parse_batch, parse_event
from fakes import CNPJ_OK, FakeRepo, make_certificate, make_client

NS = "http://www.sped.fazenda.gov.br/nfse"
OTHER = "99888777000155"  # prestador/tomador de fora (fictício)
THUMB = "A" * 40


def chave(cnpj: str, numero: int, aamm: str) -> str:
    """Chave de 50 números no formato do ADN (município + ambiente + tipo + CNPJ + número + AAMM + código)."""
    return "2211001" + "1" + "2" + cnpj + f"{numero:013d}" + aamm + "000000001" + "7"


def nfse_xml(
    key: str,
    *,
    prest: str,
    toma: str | None,
    numero: int,
    compet: str,
    valor: str = "1500.00",
    ret: str = "1",
    iss: str = "75.00",
) -> bytes:
    toma_xml = f"<toma><CNPJ>{toma}</CNPJ><xNome>TOMADORA FICTICIA</xNome></toma>" if toma else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="{NS}" versao="1.00"><infNFSe Id="NFS{key}">
<xLocEmi>Teresina</xLocEmi><xLocPrestacao>Teresina</xLocPrestacao><nNFSe>{numero}</nNFSe>
<cLocIncid>2211001</cLocIncid><xLocIncid>Teresina</xLocIncid><cStat>100</cStat><dhProc>{compet}-15T10:00:00-03:00</dhProc>
<emit><CNPJ>{prest}</CNPJ><xNome>PRESTADORA FICTICIA LTDA</xNome><enderNac><cMun>2211001</cMun><UF>PI</UF></enderNac></emit>
<valores><vBC>{valor}</vBC><vISSQN>{iss}</vISSQN><vLiq>{valor}</vLiq></valores>
<DPS versao="1.00"><infDPS Id="DPS1"><dhEmi>{compet}-15T09:00:00-03:00</dhEmi><serie>900</serie><nDPS>{numero}</nDPS>
<dCompet>{compet}-15</dCompet><prest><CNPJ>{prest}</CNPJ></prest>{toma_xml}
<serv><cServ><cTribNac>010101</cTribNac><xDescServ>Servico ficticio de consultoria</xDescServ></cServ></serv>
<valores><vServPrest><vServ>{valor}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>{ret}</tpRetISSQN></tribMun></trib></valores>
</infDPS></DPS></infNFSe></NFSe>""".encode()


def cancel_xml(key: str) -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<evento xmlns="{NS}" versao="1.00"><infEvento Id="EVT{key}101101001"><nSeqEvento>1</nSeqEvento>
<pedRegEvento versao="1.00"><infPedReg Id="PRE{key}101101"><tpAmb>1</tpAmb><dhEvento>2026-09-20T10:00:00-03:00</dhEvento>
<CNPJAutor>{CNPJ_OK}</CNPJAutor><chNFSe>{key}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>
<xMotivo>Erro na emissao</xMotivo></e101101></infPedReg></pedRegEvento></infEvento></evento>""".encode()


def doc(nsu: int, key: str, xml: bytes, tipo: str = "NFSE") -> AdnDocument:
    return AdnDocument(nsu=nsu, chave=key, tipo=tipo, xml=xml)


class FakeAdn:
    """API do ADN simulada: cada NSU pedido devolve os documentos seguintes (até 50)."""

    def __init__(self, docs: list[AdnDocument]) -> None:
        self.docs = docs
        self.calls: list[int] = []

    async def fetch(self, nsu: int) -> AdnBatch:
        self.calls.append(nsu)
        after = [d for d in sorted(self.docs, key=lambda d: d.nsu) if d.nsu > nsu][:50]
        return AdnBatch(status="DOCUMENTOS_LOCALIZADOS" if after else NO_DOCUMENTS, documents=after)


def store(*, thumb: str = THUMB, serial: str = "ABC123", cnpj: str = CNPJ_OK) -> list[StoreCertificate]:
    return [
        StoreCertificate(
            subject=f"CN=EMPRESA A LTDA:{cnpj}, O=ICP-Brasil",
            issuer="CN=AC TESTE",
            thumbprint=thumb,
            serial_number=serial,
            has_private_key=True,
            not_before=None,
            not_after=datetime.now(timezone.utc) + timedelta(days=200),
        )
    ]


@pytest.fixture
def adn(monkeypatch: pytest.MonkeyPatch) -> FakeAdn:
    fake = FakeAdn([])
    monkeypatch.setattr(nfse_fetch, "AdnClient", lambda thumbprint: fake)

    async def loader() -> list[StoreCertificate]:
        return store()

    monkeypatch.setattr(nfse_fetch, "list_user_certificates", loader)
    return fake


def setup(repo: FakeRepo):  # noqa: ANN201
    client = make_client()
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.NFSE_FETCH], competence="2026-09")
    return client, job


def zip_names(path: str) -> list[str]:
    with zipfile.ZipFile(path) as zf:
        return sorted(zf.namelist())


# -- leitura do XML e da API --------------------------------------------------------------


def test_parse_nfse_xml_maps_provider_and_taker() -> None:
    key = chave(CNPJ_OK, 12, "2609")
    info = parse_note_xml(nfse_xml(key, prest=CNPJ_OK, toma=OTHER, numero=12, compet="2026-09", ret="2"))
    assert info is not None
    assert info.chave == key and len(info.chave) == 50
    assert (info.numero, info.serie, info.valor) == (12, 900, "1500.00")
    assert (info.emit_doc, info.emit_nome, info.emit_uf) == (CNPJ_OK, "PRESTADORA FICTICIA LTDA", "PI")
    assert (info.dest_doc, info.dest_nome) == (OTHER, "TOMADORA FICTICIA")
    assert (info.iss_retido, info.iss_valor, info.municipio) == (True, "75.00", "Teresina")
    assert info.servico == "Servico ficticio de consultoria"
    assert info.competence == "2026-09"
    assert info.cstat == "100"


def test_parse_batch_unpacks_gzip_base64_and_events() -> None:
    key = chave(OTHER, 3, "2609")
    payload = {
        "StatusProcessamento": "DOCUMENTOS_LOCALIZADOS",
        "LoteDFe": [
            {"NSU": 8, "ChaveAcesso": key, "TipoDocumento": "EVENTO", "ArquivoXml": base64.b64encode(gzip.compress(cancel_xml(key))).decode()},
            {"NSU": 7, "ChaveAcesso": key, "TipoDocumento": "NFSE", "ArquivoXml": base64.b64encode(gzip.compress(b"<NFSe/>")).decode()},
        ],
    }
    batch = parse_batch(payload)
    assert [d.nsu for d in batch.documents] == [7, 8]  # em ordem de NSU
    assert batch.last_nsu == 8
    event = parse_event(batch.documents[1].xml)
    assert event is not None and event.cancels and event.chave == key
    assert event.descricao == "Cancelamento de NFS-e"


async def test_adn_client_reads_statuses(tmp_path: Path) -> None:
    responses: list[tuple[int, str, str]] = []
    outs: list[Path] = []

    async def runner(url: str, thumbprint: str, out: Path, timeout: int) -> tuple[int, str]:
        outs.append(out)
        status, detail, body = responses.pop(0)
        if body:
            out.write_text(body, encoding="utf-8")
        assert url.startswith("https://adn.nfse.gov.br/contribuintes/DFe/") and url.endswith("?lote=true")
        assert thumbprint == THUMB
        return status, detail

    client = AdnClient(THUMB.lower(), runner=runner)
    responses.append((404, "", '{"StatusProcessamento":"NENHUM_DOCUMENTO_LOCALIZADO","LoteDFe":[],"Erros":[{"Codigo":"E2220","Descricao":"Nenhum documento localizado"}]}'))
    assert (await client.fetch(14)).empty
    responses.append((403, "", '{"Erros":[{"Codigo":"E0001","Descricao":"Certificado nao autorizado"}]}'))
    with pytest.raises(AutomationError) as refused:
        await client.fetch(0)
    assert refused.value.code == ErrorCode.CERTIFICATE_REQUIRED and not refused.value.retryable
    responses.append((503, "", "Service Unavailable"))
    with pytest.raises(AutomationError) as down:
        await client.fetch(0)
    assert down.value.code == ErrorCode.NFSE_UNAVAILABLE and down.value.retryable
    responses.append((0, "CERT_NOT_FOUND", ""))
    with pytest.raises(CertificateNotInstalledError):
        await client.fetch(0)
    assert outs and not any(p.exists() for p in outs)  # a resposta temporária não fica no disco


# -- trabalho completo ----------------------------------------------------------------------


async def test_first_fetch_writes_one_zip_per_type_and_month(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    client, job = setup(repo)
    k1 = chave(CNPJ_OK, 1, "2609")  # prestada em 09
    k2 = chave(OTHER, 7, "2609")  # tomada em 09
    k3 = chave(OTHER, 6, "2608")  # tomada em 08
    adn.docs = [
        doc(1, k1, nfse_xml(k1, prest=CNPJ_OK, toma=OTHER, numero=1, compet="2026-09")),
        doc(2, k2, nfse_xml(k2, prest=OTHER, toma=CNPJ_OK, numero=7, compet="2026-09", ret="2")),
        doc(3, k3, nfse_xml(k3, prest=OTHER, toma=CNPJ_OK, numero=6, compet="2026-08")),
    ]
    assert await SchedulerRunner(deps).run_once()

    j = repo.job(job.id)
    assert j["status"] == "completed", repo.log_messages()
    assert j["last_message"] == "NFS-e: 1 prestada(s) e 2 tomada(s) nova(s)."
    assert adn.calls == [0]  # primeira busca começa do zero; menos de 50: acabou
    assert repo.nfse_cursors[client.id] == {"last_nsu": 3, "last_documents": 3}
    files = {(d["document_type"], d["competence"]): d for d in repo.downloads}
    assert set(files) == {("NFSE_PRESTADAS", "2026-09"), ("NFSE_TOMADAS", "2026-09"), ("NFSE_TOMADAS", "2026-08")}
    tomadas = files[("NFSE_TOMADAS", "2026-09")]
    assert tomadas["filename"] == "Empresa A - NFS-e tomadas - 09-2026 - CLI000001.zip"
    assert Path(tomadas["filepath"]).parts[-5:-1] == ("2026", "09", "Empresa A", "NFSE_TOMADAS")
    assert zip_names(tomadas["filepath"]) == [f"NFSe {k2}.xml"]
    # índice na hora, com a chave de 50 números e o ISS
    notes = {n["chave"]: n for n in repo.notes}
    assert notes[k2]["document_type"] == "NFSE_TOMADAS" and notes[k2]["iss_retido"] is True
    assert notes[k1]["document_type"] == "NFSE_PRESTADAS" and notes[k1]["competence"] == "2026-09"
    assert notes[k3]["competence"] == "2026-08"
    (task,) = [t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.NFSE_FETCH]
    assert task["status"] == TaskStatus.COMPLETED
    assert task["result"]["new_notes"] == {"NFSE_PRESTADAS": 1, "NFSE_TOMADAS": 2}


async def test_new_notes_make_a_new_version_and_cancel_marks_the_note(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    client, job = setup(repo)
    k1 = chave(OTHER, 7, "2609")
    adn.docs = [doc(1, k1, nfse_xml(k1, prest=OTHER, toma=CNPJ_OK, numero=7, compet="2026-09"))]
    await SchedulerRunner(deps).run_once()
    first = repo.downloads[0]

    # segunda busca: uma tomada nova do mesmo mês e o cancelamento da primeira
    k2 = chave(OTHER, 8, "2609")
    adn.docs += [
        doc(2, k2, nfse_xml(k2, prest=OTHER, toma=CNPJ_OK, numero=8, compet="2026-09")),
        doc(3, k1, cancel_xml(k1), tipo="EVENTO"),
    ]
    job2 = repo.add_job(client, [TaskType.NFSE_FETCH], competence="2026-10")
    await SchedulerRunner(deps).run_once()

    assert adn.calls == [0, 1]  # continuou do último NSU
    assert repo.job(job2.id)["last_message"] == "NFS-e: 1 tomada(s) nova(s); 1 cancelamento(s)."
    second = repo.downloads[-1]
    assert second["filename"] == "Empresa A - NFS-e tomadas - 09-2026 - CLI000001 (2).zip"
    assert zip_names(second["filepath"]) == sorted([f"NFSe {k1}.xml", f"NFSe {k2}.xml"])  # a versão nova tem tudo
    assert Path(first["filepath"]).is_file()  # a anterior fica (nada é apagado)
    notes = {n["chave"]: n for n in repo.notes}
    assert notes[k1]["canceled"] is True and notes[k2]["canceled"] is False
    # a manutenção reindexa a versão nova sem desmarcar o cancelamento
    for d in repo.downloads:
        d["notes_indexed_at"] = None
    await index_pending_notes(repo, deps.organizer.base_dir, skip=set())
    assert {n["chave"]: n for n in repo.notes}[k1]["canceled"] is True
    assert repo.nfse_cursors[client.id]["last_nsu"] == 3


async def test_previous_zip_found_on_disk_after_cleanup(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    client, _ = setup(repo)
    k1 = chave(OTHER, 7, "2607")
    adn.docs = [doc(1, k1, nfse_xml(k1, prest=OTHER, toma=CNPJ_OK, numero=7, compet="2026-07"))]
    await SchedulerRunner(deps).run_once()
    repo.downloads.clear()  # a limpeza automática apagou o registro (o ZIP continua na pasta)
    k2 = chave(OTHER, 9, "2607")  # nota atrasada do mesmo mês
    adn.docs.append(doc(2, k2, nfse_xml(k2, prest=OTHER, toma=CNPJ_OK, numero=9, compet="2026-07")))
    repo.add_job(client, [TaskType.NFSE_FETCH], competence="2026-10")
    await SchedulerRunner(deps).run_once()
    (dl,) = repo.downloads
    assert dl["filename"].endswith("CLI000001 (2).zip")
    assert zip_names(dl["filepath"]) == sorted([f"NFSe {k1}.xml", f"NFSe {k2}.xml"])


async def test_reading_the_same_documents_again_writes_nothing(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    client, _ = setup(repo)
    k1 = chave(CNPJ_OK, 1, "2609")
    adn.docs = [doc(1, k1, nfse_xml(k1, prest=CNPJ_OK, toma=OTHER, numero=1, compet="2026-09"))]
    await SchedulerRunner(deps).run_once()
    # o NSU não avançou (ex.: o robô caiu antes de gravar o ponto): relê, mas não grava versão repetida
    repo.nfse_cursors[client.id]["last_nsu"] = 0
    job2 = repo.add_job(client, [TaskType.NFSE_FETCH], competence="2026-10")
    await SchedulerRunner(deps).run_once()
    assert len(repo.downloads) == 1
    assert repo.job(job2.id)["last_message"] == "NFS-e: nenhuma nota nova."


async def test_documents_of_another_cnpj_are_left_out(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    _, job = setup(repo)
    k1 = chave(OTHER, 4, "2609")
    adn.docs = [doc(1, k1, nfse_xml(k1, prest=OTHER, toma="55444333000122", numero=4, compet="2026-09"))]
    await SchedulerRunner(deps).run_once()
    assert repo.downloads == []
    assert repo.job(job.id)["status"] == "completed"
    assert any("prestador nem tomador" in m for m in repo.log_messages())


async def test_pages_of_fifty_are_read_until_the_end(repo: FakeRepo, deps, adn: FakeAdn) -> None:  # noqa: ANN001
    client, _ = setup(repo)
    adn.docs = []
    for n in range(1, 61):
        k = chave(OTHER, n, "2609")
        adn.docs.append(doc(n, k, nfse_xml(k, prest=OTHER, toma=CNPJ_OK, numero=n, compet="2026-09")))
    await SchedulerRunner(deps).run_once()
    assert adn.calls == [0, 50]
    (dl,) = repo.downloads
    assert len(zip_names(dl["filepath"])) == 60
    assert repo.nfse_cursors[client.id]["last_nsu"] == 60


async def test_certificate_missing_on_this_computer_hands_over(repo: FakeRepo, deps, adn: FakeAdn, monkeypatch) -> None:  # noqa: ANN001
    async def empty_store() -> list[StoreCertificate]:
        return []

    monkeypatch.setattr(nfse_fetch, "list_user_certificates", empty_store)
    repo.other_hosts = ["PC-2"]
    _, job = setup(repo)
    await SchedulerRunner(deps).run_once()
    assert repo.handovers and repo.handovers[0][0] == job.id
    assert repo.job(job.id)["status"] != "completed"
    assert adn.calls == []


async def test_certificate_found_by_cnpj_when_registry_has_no_serial(repo: FakeRepo) -> None:
    client = make_client()
    cert = make_certificate(client, serial_number=None, thumbprint=None)

    async def loader() -> list[StoreCertificate]:
        return store(thumb="B" * 40, serial="999")

    assert await nfse_fetch.resolve_thumbprint(cert, client, store_loader=loader) == "B" * 40
