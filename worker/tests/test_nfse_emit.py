"""Emissão e cancelamento de NFS-e (tarefas NFSE_EMIT e NFSE_CANCEL): prefeitura e assinatura simuladas,
empresas e notas fictícias. Nenhum teste fala com a prefeitura de verdade."""

from __future__ import annotations

import base64
import gzip
import json
import re
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from app.certificates.windows_store import StoreCertificate
from app.downloads.note_index import evaluate_nfse_models, index_zip, note_rows, parse_note_xml
from app.jobs import nfse_emit, nfse_fetch
from app.jobs.errors import AutomationError, CertificateNotInstalledError, ErrorCode
from app.jobs.models import TaskStatus, TaskType
from app.jobs.scheduler_runner import SchedulerRunner
from app.nfse.adn import NO_DOCUMENTS, AdnBatch, AdnDocument
from app.nfse.dps import DpsRequest, build_cancel, build_dps, dps_id, ibs_codes, key_number, model_status
from app.nfse.prefeitura import ApiResult, PrefeituraClient
from app.nfse.signer import sign_xml
from fakes import CNPJ_OK, FakeRepo, make_certificate, make_client

NS = "http://www.sped.fazenda.gov.br/nfse"
THUMB = "B" * 40
TOMADOR = "55666777000188"
OUTRO_TOMADOR = "99888777000155"
MES = datetime.now(timezone(timedelta(hours=-3))).strftime("%Y-%m")


def chave(numero: int, aamm: str = "2609") -> str:
    return "2211001" + "1" + "2" + CNPJ_OK + f"{numero:013d}" + aamm + "000000001" + "7"


def nota(
    key: str,
    *,
    numero: int,
    toma: str | None = TOMADOR,
    valor: str = "1200.00",
    compet: str = "2026-09",
    simples: str = "3",
    ret: str = "1",
    obra: bool = False,
    amb: str = "1",
    extra_trib: str = "",
    municipio: str = "2211001",
    ibs: str = "",
) -> bytes:
    toma_xml = (
        f"<toma><CNPJ>{toma}</CNPJ><xNome>CONDOMINIO FICTICIO SOL</xNome><end><endNac><cMun>2211001</cMun><CEP>64000100</CEP></endNac>"
        "<xLgr>RUA DAS FLORES</xLgr><nro>100</nro><xBairro>CENTRO</xBairro></end><email>sindico@ficticio.test</email></toma>"
        if toma
        else ""
    )
    obra_xml = "<obra><end><CEP>64000200</CEP><xLgr>RUA DA OBRA</xLgr><nro>5</nro><xBairro>NORTE</xBairro></end></obra>" if obra else ""
    return (
        f'<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="{NS}" versao="1.01"><infNFSe Id="NFS{key}">'
        f"<xLocEmi>TERESINA</xLocEmi><xLocPrestacao>TERESINA</xLocPrestacao><nNFSe>{numero}</nNFSe><cLocIncid>2211001</cLocIncid>"
        "<xLocIncid>TERESINA</xLocIncid><xTribNac>Lubrificacao, limpeza e revisao.</xTribNac><xTribMun>MANUTENCAO DE AR-CONDICIONADO</xTribMun>"
        f"<verAplic>1.01</verAplic><ambGer>{amb}</ambGer><tpEmis>2</tpEmis><cStat>100</cStat><dhProc>{compet}-08T10:00:00-03:00</dhProc>"
        f"<emit><CNPJ>{CNPJ_OK}</CNPJ><IM>1234567</IM><xNome>EMPRESA A LTDA</xNome><enderNac><xLgr>RUA A</xLgr><nro>10</nro>"
        "<xBairro>CENTRO</xBairro><cMun>2211001</cMun><UF>PI</UF><CEP>64000000</CEP></enderNac><email>contato@empresa-a.test</email></emit>"
        f'<valores><vLiq>{valor}</vLiq></valores><DPS versao="1.01"><infDPS Id="DPS{municipio}2{CNPJ_OK}00001{numero:015d}">'
        f"<tpAmb>1</tpAmb><dhEmi>{compet}-08T10:00:00-03:00</dhEmi><verAplic>1.01</verAplic><serie>00001</serie><nDPS>{numero}</nDPS>"
        f"<dCompet>{compet}-01</dCompet><tpEmit>1</tpEmit><cLocEmi>{municipio}</cLocEmi>"
        f"<prest><CNPJ>{CNPJ_OK}</CNPJ><IM>1234567</IM><email>contato@empresa-a.test</email>"
        f"<regTrib><opSimpNac>{simples}</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>{toma_xml}"
        "<serv><locPrest><cLocPrestacao>2211001</cLocPrestacao></locPrest><cServ><cTribNac>140101</cTribNac><cTribMun>040</cTribMun>"
        f"<xDescServ>Manutencao preventiva dos aparelhos</xDescServ><cNBS>101061200</cNBS></cServ>{obra_xml}</serv>"
        f"<valores><vServPrest><vServ>{valor}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>{ret}</tpRetISSQN>"
        f"{extra_trib}</tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>{ibs}</infDPS></DPS></infNFSe></NFSe>"
    ).encode()


def pack(xml: bytes) -> str:
    return base64.b64encode(gzip.compress(xml)).decode()


async def fake_sign(xml: str, thumbprint: str, element: str) -> bytes:
    fecho = "</DPS>" if element == "infDPS" else "</pedRegEvento>"
    return xml.replace(fecho, "<Signature>assinado</Signature>" + fecho).encode()


class FakeApi:
    """Prefeitura simulada: guarda as DPS recebidas e devolve a nota como a API de verdade."""

    def __init__(self) -> None:
        self.dps: dict[str, str] = {}  # Id da DPS -> chave da nota
        self.notes: dict[str, bytes] = {}
        self.sent: list[bytes] = []
        self.events: list[tuple[str, bytes]] = []
        self.lookups: list[str] = []
        self.next_numero = 128
        self.emit_errors: list[dict[str, str]] | None = None
        self.emit_silent = False  # recebe, gera a nota, mas a resposta se perde (queda de rede)
        self.event_errors: list[dict[str, str]] | None = None
        self.test_env: bool | None = None

    def __call__(self, thumbprint: str, *, test_env: bool) -> "FakeApi":
        self.thumbprint, self.test_env = thumbprint, test_env
        return self

    async def find_by_dps(self, ident: str) -> str | None:
        self.lookups.append(ident)
        return self.dps.get(ident)

    async def get_nfse(self, key: str) -> bytes | None:
        return self.notes.get(key)

    async def emit(self, signed: bytes) -> ApiResult:
        self.sent.append(signed)
        if self.emit_errors is not None:
            return ApiResult(status=400, data={"erros": self.emit_errors})
        text = signed.decode()
        ident = re.search(r'Id="(DPS\d{42})"', text).group(1)
        numero, self.next_numero = self.next_numero, self.next_numero + 1
        key = chave(numero, "2610")
        dps = re.search(r"<DPS .*</DPS>", text, re.S).group(0)
        xml = (
            f'<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="{NS}" versao="1.01"><infNFSe Id="NFS{key}"><xLocEmi>TERESINA</xLocEmi>'
            f"<xLocPrestacao>TERESINA</xLocPrestacao><nNFSe>{numero}</nNFSe><cLocIncid>2211001</cLocIncid><xLocIncid>TERESINA</xLocIncid>"
            "<xTribMun>MANUTENCAO DE AR-CONDICIONADO</xTribMun><ambGer>1</ambGer><tpEmis>2</tpEmis><cStat>100</cStat>"
            f"<emit><CNPJ>{CNPJ_OK}</CNPJ><xNome>EMPRESA A LTDA</xNome></emit><valores><vLiq>1.00</vLiq></valores>{dps}</infNFSe></NFSe>"
        ).encode()
        self.dps[ident] = key
        self.notes[key] = xml
        if self.emit_silent:
            self.emit_silent = False
            return ApiResult(status=0, detail="a prefeitura não respondeu a tempo")
        return ApiResult(status=201, data={"chaveAcesso": "NFS" + key, "nfseXmlGZipB64": pack(xml), "erros": []})

    async def register_event(self, key: str, signed: bytes) -> ApiResult:
        self.events.append((key, signed))
        if self.event_errors is not None:
            return ApiResult(status=400, data={"erros": self.event_errors})
        return ApiResult(status=200, data={"eventoXmlGZipB64": pack(b"<evento/>")})


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FakeApi:
    fake = FakeApi()
    monkeypatch.setattr(nfse_emit, "PrefeituraClient", fake)
    monkeypatch.setattr(nfse_emit, "sign_xml", fake_sign)

    async def loader() -> list[StoreCertificate]:
        return [
            StoreCertificate(
                subject=f"CN=EMPRESA A LTDA:{CNPJ_OK}, O=ICP-Brasil", issuer="CN=AC TESTE", thumbprint=THUMB, serial_number="ABC123",
                has_private_key=True, not_before=None, not_after=datetime.now(timezone.utc) + timedelta(days=200),
            )
        ]

    monkeypatch.setattr(nfse_fetch, "list_user_certificates", loader)
    return fake


class FakeAdn:
    """Sistema nacional simulado: devolve os documentos depois do ponto de leitura."""

    def __init__(self) -> None:
        self.docs: list[AdnDocument] = []

    async def fetch(self, nsu: int) -> AdnBatch:
        after = [d for d in self.docs if d.nsu > nsu]
        return AdnBatch(status="DOCUMENTOS_LOCALIZADOS" if after else NO_DOCUMENTS, documents=after)


def break_lookup(api: FakeApi) -> None:
    """A consulta da nota pela chave falha, como a prefeitura faz em nota com dados de obra (erro interno L9999)."""

    async def broken(key: str) -> bytes | None:
        raise AutomationError(ErrorCode.NFSE_UNAVAILABLE, "A prefeitura não devolveu a NFS-e (HTTP 500: L9999).", retryable=True)

    api.get_nfse = broken  # type: ignore[method-assign]


async def seed(repo: FakeRepo, tmp_path: Path, client: Any, notas: dict[str, bytes], comp: str = "2026-09") -> Path:
    """Notas já baixadas do cliente: um ZIP na pasta e as linhas do índice, como o robô grava."""
    path = tmp_path / f"prestadas-{comp}-{uuid.uuid4().hex[:6]}.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for key, xml in notas.items():
            zf.writestr(f"NFSe {key}.xml", xml)
    row = {"id": str(uuid.uuid4()), "client_id": client.id, "document_type": "NFSE_PRESTADAS", "competence": comp, "filepath": str(path),
           "filename": path.name, "size": path.stat().st_size, "checksum": "x", "notes_indexed_at": "ok", "downloaded_at": "2026-09-30"}
    repo.downloads.append(row)
    await repo.upsert_notes(note_rows(row, path, index_zip(path) or []))
    return path


def setup(repo: FakeRepo, **emission: Any):  # noqa: ANN201
    client = make_client()
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.NFSE_EMIT], competence=MES)
    em = repo.add_emission(
        client, job, model_chave=chave(127), toma_chave=chave(127), toma_doc=TOMADOR, toma_nome="CONDOMINIO FICTICIO SOL",
        description="Manutenção do ar do salão & copa", amount="1500.00", **emission,
    )
    return client, job, em


# -- a nota-modelo e a DPS ------------------------------------------------------------------


def test_model_status_says_which_notes_can_be_repeated() -> None:
    k = chave(1)
    assert model_status(nota(k, numero=1).decode()) == "ok"
    assert model_status(nota(k, numero=1, obra=True).decode()) == "mesmo_tomador"
    assert model_status(nota(k, numero=1, ret="2").decode()) == "mesmo_tomador"
    assert model_status(nota(k, numero=1, simples="1").decode()) == "fora_simples"
    assert model_status(nota(k, numero=1, simples="2").decode()) == "fora_simples"  # MEI emite pelo emissor nacional
    assert model_status(nota(k, numero=1, amb="2").decode()) == "emissor_nacional"
    assert model_status(nota(k, numero=1, municipio="2111300").decode()) == "outro_municipio"
    assert model_status(nota(k, numero=1, extra_trib="<vRetISS>10.00</vRetISS>").decode()) == "valores_de_imposto"
    assert model_status("<NFSe><infNFSe/></NFSe>") == "sem_dps"


def test_index_keeps_service_codes_and_model_status() -> None:
    info = parse_note_xml(nota(chave(7), numero=7, obra=True), "NFSe x.xml")
    assert info is not None
    assert (info.c_trib_nac, info.c_trib_mun, info.c_nbs, info.c_loc_emi) == ("140101", "040", "101061200", "2211001")
    assert info.servico_nome == "MANUTENCAO DE AR-CONDICIONADO" and info.emit_model == "mesmo_tomador"


def test_dps_copies_what_cannot_be_invented_and_changes_only_what_was_confirmed() -> None:
    model = nota(chave(127), numero=127).decode()
    now = datetime(2026, 10, 10, 15, 30, tzinfo=timezone(timedelta(hours=-3)))
    xml, ident = build_dps(
        DpsRequest(cnpj=CNPJ_OK, numero=3, amount=Decimal("1500"), description="Manutenção do ar & copa <urgente>", competence="2026-10",
                   model_xml=model, prest_xml=model, taker_xml=model, now=now)
    )
    assert ident == dps_id(CNPJ_OK, 3) == f"DPS22110012{CNPJ_OK}10001000000000000003" and len(ident) == 45
    assert f'<infDPS Id="{ident}"><tpAmb>1</tpAmb><dhEmi>2026-10-10T15:28:00-03:00</dhEmi><verAplic>JRSistema</verAplic>' in xml
    assert "<serie>10001</serie><nDPS>3</nDPS><dCompet>2026-10-01</dCompet><tpEmit>1</tpEmit><cLocEmi>2211001</cLocEmi>" in xml
    # prestador, códigos do serviço e tributação: iguais aos da nota real
    assert f"<prest><CNPJ>{CNPJ_OK}</CNPJ><IM>1234567</IM><regTrib><opSimpNac>3</opSimpNac>" in xml
    assert "<cTribNac>140101</cTribNac><cTribMun>040</cTribMun>" in xml and "<cNBS>101061200</cNBS>" in xml
    assert "<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>" in xml
    # o que a pessoa conferiu: descrição (com os caracteres especiais protegidos) e valor
    assert "<xDescServ>Manutenção do ar &amp; copa &lt;urgente&gt;</xDescServ>" in xml
    assert "<vServPrest><vServ>1500.00</vServ></vServPrest>" in xml
    # tomador copiado da nota dele, sem e-mail nem telefone
    assert f"<toma><CNPJ>{TOMADOR}</CNPJ><xNome>CONDOMINIO FICTICIO SOL</xNome><end>" in xml
    assert "email" not in xml and "fone" not in xml and "<Signature" not in xml
    assert "<tpAmb>2</tpAmb>" in build_dps(
        DpsRequest(cnpj=CNPJ_OK, numero=1, amount=Decimal("1"), description="Teste", competence="2026-10", model_xml=model, prest_xml=model, test_env=True, now=now)
    )[0]


def test_dps_new_taker_and_refusals() -> None:
    model = nota(chave(127), numero=127).decode()
    base = dict(cnpj=CNPJ_OK, numero=1, amount=Decimal("80"), description="Visita técnica", competence=MES, model_xml=model, prest_xml=model)
    novo = {"doc": "11.222.333/0001-81", "nome": "Mercado Bom & Barato", "cmun": "2211001", "cep": "64000-100", "logradouro": "Rua B", "numero": "20", "bairro": "Sul"}
    xml, _ = build_dps(DpsRequest(**base, taker=novo))
    assert "<toma><CNPJ>11222333000181</CNPJ><xNome>Mercado Bom &amp; Barato</xNome><end><endNac><cMun>2211001</cMun><CEP>64000100</CEP></endNac>" in xml
    assert "<toma>" not in build_dps(DpsRequest(**base))[0]  # sem tomador identificado
    with pytest.raises(AutomationError, match="incompletos"):
        build_dps(DpsRequest(**base, taker={"doc": "123", "nome": "X"}))
    with pytest.raises(AutomationError, match="não é deste cliente"):
        build_dps(DpsRequest(**{**base, "cnpj": OUTRO_TOMADOR}))
    with pytest.raises(AutomationError, match="fora do Simples"):
        build_dps(DpsRequest(**{**base, "model_xml": nota(chave(1), numero=1, simples="1").decode()}))
    with pytest.raises(AutomationError, match="posterior"):
        build_dps(DpsRequest(**{**base, "competence": "2099-01"}))
    # obra e ISS retido valem para aquele tomador: só se repete para ele
    obra = nota(chave(5), numero=5, obra=True).decode()
    assert "<obra>" in build_dps(DpsRequest(**{**base, "model_xml": obra}, taker_xml=obra))[0]
    with pytest.raises(AutomationError, match="mesmo tomador"):
        build_dps(DpsRequest(**{**base, "model_xml": obra}, taker=novo))


def test_cancel_request_xml() -> None:
    k = chave(128, "2610")
    xml = build_cancel(k, CNPJ_OK, 1, "Valor combinado  foi alterado", test_env=True)
    assert f'<infPedReg Id="PRE{k}101101001"><tpAmb>2</tpAmb>' in xml
    assert f"<CNPJAutor>{CNPJ_OK}</CNPJAutor><chNFSe>{k}</chNFSe><nPedRegEvento>1</nPedRegEvento>" in xml
    assert "<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Valor combinado foi alterado</xMotivo></e101101>" in xml
    for bad in (dict(reason_code=7), dict(reason="curto")):
        with pytest.raises(AutomationError):
            build_cancel(k, CNPJ_OK, **{"reason_code": 1, "reason": "Valor combinado foi alterado", **bad}, test_env=False)


IBS = (
    "<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><indDest>0</indDest><valores><trib><gIBSCBS><CST>200</CST>"
    "<cClassTrib>200052</cClassTrib></gIBSCBS></trib></valores></IBSCBS>"
)


def test_activity_nbs_and_ibs_can_be_informed_by_hand() -> None:
    model = nota(chave(127), numero=127).decode()
    base = dict(cnpj=CNPJ_OK, numero=1, amount=Decimal("80"), description="Projeto elétrico", competence=MES, model_xml=model, prest_xml=model)
    # sem nada informado: tudo como na nota-modelo
    xml, _ = build_dps(DpsRequest(**base))
    assert "<cTribNac>140101</cTribNac><cTribMun>040</cTribMun>" in xml and "<cNBS>101061200</cNBS>" in xml and "<IBSCBS>" not in xml
    # outra atividade do cadastro da empresa, outro NBS e os códigos de IBS/CBS
    xml, _ = build_dps(DpsRequest(**base, c_trib_nac="07.03.01", c_trib_mun="002", c_nbs="1.1402.11.00", ibs={"cst": "000", "class_trib": "000001", "ind_op": "050101"}))
    assert "<cTribNac>070301</cTribNac><cTribMun>002</cTribMun><xDescServ>Projeto elétrico</xDescServ><cNBS>114021100</cNBS></cServ>" in xml
    assert xml.endswith(
        "</trib></valores><IBSCBS><finNFSe>0</finNFSe><cIndOp>050101</cIndOp><indDest>0</indDest><valores><trib><gIBSCBS><CST>000</CST>"
        "<cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS></infDPS></DPS>"
    )
    # campo apagado no painel: a nota vai sem ele
    xml, _ = build_dps(DpsRequest(**base, c_nbs="", ibs={"cst": "", "class_trib": "", "ind_op": ""}))
    assert "<cNBS>" not in xml and "<IBSCBS>" not in xml
    for bad in (dict(c_trib_nac="1234", c_trib_mun="002"), dict(c_nbs="123"), dict(ibs={"cst": "000", "class_trib": "", "ind_op": ""})):
        with pytest.raises(AutomationError):
            build_dps(DpsRequest(**base, **bad))
    # obra ou ISS retido vêm da nota-modelo: com eles não se troca a atividade
    obra = nota(chave(5), numero=5, obra=True).decode()
    with pytest.raises(AutomationError, match="outra atividade"):
        build_dps(DpsRequest(**{**base, "model_xml": obra}, taker_xml=obra, c_trib_nac="070301", c_trib_mun="002"))


def test_simple_ibs_group_is_read_copied_and_indexed() -> None:
    com = nota(chave(9), numero=9, ibs=IBS)
    assert model_status(com.decode()) == "ok"
    assert ibs_codes(com.decode()) == {"cst": "200", "class_trib": "200052", "ind_op": "100301"}
    info = parse_note_xml(com, "NFSe x.xml")
    assert info is not None and (info.ibs_cst, info.ibs_class_trib, info.ibs_ind_op) == ("200", "200052", "100301")
    assert parse_note_xml(nota(chave(8), numero=8), "NFSe y.xml").ibs_cst is None
    # repetir a nota leva o mesmo grupo; com destinatário, imóvel ou valores a nota não serve de modelo
    xml, _ = build_dps(DpsRequest(cnpj=CNPJ_OK, numero=1, amount=Decimal("10"), description="Repetição", competence=MES, model_xml=com.decode(), prest_xml=com.decode()))
    assert IBS in xml
    complexo = IBS.replace("<indDest>0</indDest>", "<indDest>1</indDest><dest><CNPJ>99888777000155</CNPJ><xNome>X</xNome></dest>")
    assert model_status(nota(chave(9), numero=9, ibs=complexo).decode()) == "ibs_cbs"


async def test_emit_uses_the_codes_confirmed_in_the_panel(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(
        repo, custom_service=True, c_trib_nac="070301", c_trib_mun="002", c_nbs="114021100", ibs_cst="000", ibs_class_trib="000001", ibs_ind_op="050101"
    )
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    text = api.sent[0].decode()
    assert "<cTribNac>070301</cTribNac><cTribMun>002</cTribMun>" in text and "<cNBS>114021100</cNBS>" in text
    assert "<cIndOp>050101</cIndOp>" in text and "<CST>000</CST><cClassTrib>000001</cClassTrib>" in text
    # a nota emitida entra no índice com os códigos de IBS/CBS
    assert any(n["chave"] == em["chave"] and n["ibs_class_trib"] == "000001" and n["c_trib_nac"] == "070301" for n in repo.notes)


# -- API da prefeitura e assinatura (PowerShell simulado) --------------------------------------


async def test_prefeitura_client_reads_answers_and_never_mixes_environments() -> None:
    calls: list[tuple[str, bytes | None]] = []
    answers: list[tuple[int, bytes]] = []

    async def runner(url: str, thumbprint: str, body: bytes | None, out: Path, timeout: int) -> tuple[int, str]:
        calls.append((url, body))
        status, raw = answers.pop(0)
        out.write_bytes(raw)
        return status, ""

    k = chave(128, "2610")
    prod = PrefeituraClient(THUMB, test_env=False, runner=runner)
    answers.append((201, json.dumps({"chaveAcesso": "NFS" + k, "nfseXmlGZipB64": pack(b"<NFSe/>")}).encode()))
    r = await prod.emit(b"<DPS><tpAmb>1</tpAmb><Signature/></DPS>")
    assert (r.status, r.chave, r.xml("nfseXmlGZipB64")) == (201, k, "<NFSe/>")
    assert calls[0][0] == "https://nfseapi.teresina.pi.gov.br/notafiscal-ws/nfse"
    assert gzip.decompress(base64.b64decode(json.loads(calls[0][1])["dpsXmlGZipB64"])) == b"<DPS><tpAmb>1</tpAmb><Signature/></DPS>"
    # nota de teste nunca vai para a produção; nota sem assinatura não sai
    with pytest.raises(AutomationError, match="envio bloqueado"):
        await prod.emit(b"<DPS><tpAmb>2</tpAmb><Signature/></DPS>")
    with pytest.raises(AutomationError, match="envio bloqueado"):
        await prod.emit(b"<DPS><tpAmb>1</tpAmb></DPS>")
    assert len(calls) == 1
    # recusa de negócio (acentos em Latin-1, como a prefeitura às vezes manda)
    answers.append((400, '{"erros":[{"codigo":"L0001","mensagem":"Código de tributação não vinculado"}]}'.encode("latin-1")))
    r = await prod.emit(b"<DPS><tpAmb>1</tpAmb><Signature/></DPS>")
    assert r.errors == [{"codigo": "L0001", "mensagem": "Código de tributação não vinculado"}]
    # consulta pela DPS: 404 = número livre; 200 = a nota existe
    ident = dps_id(CNPJ_OK, 1)
    answers += [(404, b'{"erros":[{}]}'), (200, json.dumps({"chaveAcesso": "NFS" + k}).encode())]
    assert await prod.find_by_dps(ident) is None
    assert await prod.find_by_dps(ident) == k
    answers.append((500, b""))
    with pytest.raises(AutomationError) as err:
        await prod.find_by_dps(ident)
    assert err.value.code == ErrorCode.NFSE_UNAVAILABLE and err.value.retryable
    # certificado recusado: tentar de novo não resolve
    answers.append((403, b""))
    with pytest.raises(AutomationError) as err:
        await prod.get_nfse(k)
    assert err.value.code == ErrorCode.CERTIFICATE_REQUIRED
    # ambiente de teste usa o endereço de teste
    test = PrefeituraClient(THUMB, test_env=True, runner=runner)
    answers.append((200, json.dumps({"eventoXmlGZipB64": pack(b"<evento/>")}).encode()))
    r = await test.register_event(k, b"<pedRegEvento><tpAmb>2</tpAmb><Signature/></pedRegEvento>")
    assert r.xml("eventoXmlGZipB64") == "<evento/>" and calls[-1][0] == f"https://nfse2-the.dsfweb.com.br/notafiscal-ws/nfse/{k}/eventos"

    async def no_cert(url: str, thumbprint: str, body: bytes | None, out: Path, timeout: int) -> tuple[int, str]:
        return 0, "CERT_NOT_FOUND"

    with pytest.raises(CertificateNotInstalledError):
        await PrefeituraClient(THUMB, test_env=False, runner=no_cert).get_nfse(k)


async def test_signer_returns_the_signed_file_or_explains() -> None:
    async def ok(source: Path, thumbprint: str, element: str, out: Path) -> str:
        out.write_bytes(source.read_bytes().replace(b"</DPS>", b"<Signature/></DPS>"))
        return "OK"

    assert await sign_xml("<DPS><infDPS Id='x'/></DPS>", THUMB, "infDPS", runner=ok) == b"<DPS><infDPS Id='x'/><Signature/></DPS>"

    async def missing(source: Path, thumbprint: str, element: str, out: Path) -> str:
        return "CERT_NOT_FOUND"

    with pytest.raises(CertificateNotInstalledError):
        await sign_xml("<DPS/>", THUMB, "infDPS", runner=missing)

    async def broken(source: Path, thumbprint: str, element: str, out: Path) -> str:
        return "ERROR chave inacessivel"

    with pytest.raises(AutomationError, match="chave inacessivel"):
        await sign_xml("<DPS/>", THUMB, "infDPS", runner=broken)
    with pytest.raises(AutomationError, match="não previsto"):
        await sign_xml("<DPS/>", THUMB, "infNFSe", runner=ok)


# -- o trabalho de emissão ----------------------------------------------------------------------


async def test_emit_sends_one_note_and_stores_it(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127), chave(126): nota(chave(126), numero=126, toma=OUTRO_TOMADOR)})
    assert await SchedulerRunner(deps).run_once()

    j = repo.job(job.id)
    assert j["status"] == "completed", repo.log_messages()
    assert j["last_message"] == "NFS-e nº 128 emitida: R$ 1.500,00 para CONDOMINIO FICTICIO SOL."
    assert api.test_env is False and api.thumbprint == THUMB
    (sent,) = api.sent
    text = sent.decode()
    assert f'Id="{dps_id(CNPJ_OK, 1)}"' in text and "<tpAmb>1</tpAmb>" in text and "<Signature>" in text
    assert "<vServ>1500.00</vServ>" in text and f"<toma><CNPJ>{TOMADOR}</CNPJ>" in text
    key = chave(128, "2610")
    assert (em["status"], em["chave"], em["numero"], em["n_dps"], em["id_dps"]) == ("issued", key, 128, 1, dps_id(CNPJ_OK, 1))
    assert em["nfse_xml"].startswith("<?xml") and set(em["steps"]) == {"started_at", "signed_at", "sent_at", "issued_at"}
    assert em["send_started_at"] is not None and em["errors"] == []
    # a nota entra no ZIP de prestadas do mês e no índice, como as que o robô baixa
    novo = next(d for d in repo.downloads if d["competence"] == MES)
    with zipfile.ZipFile(novo["filepath"]) as zf:
        assert zf.namelist() == [f"NFSe {key}.xml"] and zf.read(f"NFSe {key}.xml") == api.notes[key]
    assert any(n["chave"] == key and n["emit_model"] == "ok" for n in repo.notes)
    (task,) = [t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.NFSE_EMIT]
    assert task["status"] == TaskStatus.COMPLETED and task["result"]["chave"] == key


async def test_fetch_after_emitting_never_drops_or_repeats_the_note(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    """A busca de NFS-e (sistema nacional) devolve também a nota emitida aqui: ela já está no ZIP do mês."""
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    assert await SchedulerRunner(deps).run_once()
    key = em["chave"]
    emitted = next(d for d in repo.downloads if d["competence"] == MES)

    adn = FakeAdn()
    monkeypatch.setattr(nfse_fetch, "AdnClient", lambda thumbprint: adn)

    # 1ª busca: só a nota emitida volta -> nenhum arquivo novo
    adn.docs = [AdnDocument(nsu=1, chave=key, tipo="NFSE", xml=api.notes[key])]
    repo.add_job(client, [TaskType.NFSE_FETCH], competence=MES)
    assert await SchedulerRunner(deps).run_once()
    assert [d for d in repo.downloads if d["competence"] == MES] == [emitted], repo.log_messages()

    # 2ª busca: chega outra nota do mês (emitida no site da prefeitura) -> versão nova com as duas
    outra = chave(129, "2610")
    adn.docs.append(AdnDocument(nsu=2, chave=outra, tipo="NFSE", xml=nota(outra, numero=129, compet=MES)))
    repo.add_job(client, [TaskType.NFSE_FETCH], competence=MES)
    assert await SchedulerRunner(deps).run_once()
    versions = [d for d in repo.downloads if d["competence"] == MES]
    assert len(versions) == 2, repo.log_messages()
    with zipfile.ZipFile(versions[-1]["filepath"]) as zf:
        assert sorted(zf.namelist()) == sorted([f"NFSe {key}.xml", f"NFSe {outra}.xml"])
    assert sum(1 for n in repo.notes if n["chave"] == key) == 1  # no índice, a nota emitida aparece uma vez só


async def test_number_used_outside_the_system_is_skipped(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    api.dps[dps_id(CNPJ_OK, 1)] = chave(90, "2610")  # alguém já usou o número 1 da série da API
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    assert em["n_dps"] == 2 and f'Id="{dps_id(CNPJ_OK, 2)}"' in api.sent[0].decode()
    assert api.lookups == [dps_id(CNPJ_OK, 1), dps_id(CNPJ_OK, 2)]


async def test_rejection_emits_nothing_and_frees_the_number(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    api.emit_errors = [{"codigo": "L0001", "mensagem": "Código de tributação municipal não vinculado ao cadastro"}]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert (j["status"], j["error_code"]) == ("failed", "NFSE_REJECTED"), repo.log_messages()
    assert "A prefeitura recusou a nota: Código de tributação municipal não vinculado ao cadastro (L0001)" in j["error_message"]
    assert (em["status"], em["n_dps"], em["send_started_at"], em["chave"]) == ("rejected", None, None, None)
    assert em["errors"] == api.emit_errors and len(api.sent) == 1  # recusa não é reenviada sozinha
    assert not [d for d in repo.downloads if d["competence"] == MES]


async def test_lost_answer_is_checked_before_sending_again(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    api.emit_silent = True  # a prefeitura emite, mas a resposta se perde
    runner = SchedulerRunner(deps)
    assert await runner.run_once()
    # o robô perguntou pela DPS antes de desistir e achou a nota: nada é enviado de novo
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    assert len(api.sent) == 1 and em["status"] == "issued" and em["numero"] == 128


async def test_restart_after_sending_recovers_the_note(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    # tentativa anterior: a DPS 1 saiu, virou a nota 300 na prefeitura, e o robô caiu antes de registrar
    ident, key = dps_id(CNPJ_OK, 1), chave(300, "2610")
    em.update(serie="10001", n_dps=1, id_dps=ident, send_started_at="2026-10-10T12:00:00+00:00", status="processing")
    api.dps[ident] = key
    api.notes[key] = nota(key, numero=300, compet=MES)
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    assert api.sent == [] and (em["status"], em["chave"], em["numero"]) == ("issued", key, 300)
    assert "recuperada" in em["last_message"]


async def test_note_the_prefeitura_cannot_show_is_still_registered_as_issued(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path, monkeypatch) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    # tentativa anterior: a DPS 1 virou a nota 300 e o robô caiu antes de registrar; agora a consulta da nota falha
    ident, key = dps_id(CNPJ_OK, 1), chave(300, "2610")
    em.update(serie="10001", n_dps=1, id_dps=ident, send_started_at="2026-10-10T12:00:00+00:00", status="processing")
    api.dps[ident] = key
    api.notes[key] = nota(key, numero=300, compet=MES, obra=True)
    break_lookup(api)
    assert await SchedulerRunner(deps).run_once()

    # a nota existe: o pedido fica como emitido (número tirado da chave) e o trabalho termina, sem ficar tentando
    j = repo.job(job.id)
    assert j["status"] == "completed", repo.log_messages()
    assert api.sent == [] and (em["status"], em["chave"], em["numero"], em["nfse_xml"]) == ("issued", key, 300, None)
    assert j["last_message"] == (
        "NFS-e nº 300 emitida: R$ 1.500,00 para CONDOMINIO FICTICIO SOL. "
        "Atenção: a prefeitura ainda não devolveu o arquivo da nota; a próxima busca de NFS-e traz."
    )
    assert em["last_message"].startswith("NFS-e nº 300 emitida (recuperada); a prefeitura ainda não devolveu o arquivo")
    assert not [d for d in repo.downloads if d["competence"] == MES]
    (task,) = [t for t in repo.tasks_of(job.id) if t["task_type"] == TaskType.NFSE_EMIT]
    assert task["result"]["xml_pending"] is True and key_number(key) == "300" and key_number("123") == ""

    # a busca de NFS-e traz a nota depois: o arquivo entra na pasta e completa o registro da emissão
    adn = FakeAdn()
    monkeypatch.setattr(nfse_fetch, "AdnClient", lambda thumbprint: adn)
    adn.docs = [AdnDocument(nsu=1, chave=key, tipo="NFSE", xml=api.notes[key])]
    repo.add_job(client, [TaskType.NFSE_FETCH], competence=MES)
    assert await SchedulerRunner(deps).run_once()
    assert em["nfse_xml"] == api.notes[key].decode() and em["last_message"] == "NFS-e nº 300 emitida", repo.log_messages()
    (stored,) = [d for d in repo.downloads if d["competence"] == MES]
    with zipfile.ZipFile(stored["filepath"]) as zf:
        assert zf.namelist() == [f"NFSe {key}.xml"]
    assert sum(1 for n in repo.notes if n["chave"] == key) == 1


@pytest.mark.parametrize("test_env", [False, True])
async def test_lost_answer_and_broken_lookup_never_send_twice(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path, test_env: bool) -> None:  # noqa: ANN001
    client, job, em = setup(repo, test_env=test_env)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    api.emit_silent = True  # a prefeitura emite, a resposta se perde...
    break_lookup(api)  # ...e a consulta da nota também não funciona
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "completed", repo.log_messages()
    assert len(api.sent) == 1 and (em["status"], em["numero"], em["nfse_xml"]) == ("issued", 128, None)
    # no ambiente de teste não há busca que traga o arquivo depois
    assert j["last_message"].endswith(
        "Atenção: a prefeitura não devolveu o arquivo da nota." if test_env else "a próxima busca de NFS-e traz."
    )


async def test_answer_with_the_key_but_without_the_file_is_an_issued_note(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    emit = api.emit

    async def only_key(signed: bytes) -> ApiResult:
        answer = await emit(signed)
        return ApiResult(status=201, data={"chaveAcesso": answer.data["chaveAcesso"], "erros": []})

    api.emit = only_key  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    # a chave veio na resposta: a nota existe, e o arquivo é buscado sem perguntar de novo pela DPS
    assert api.lookups == [dps_id(CNPJ_OK, 1)] and len(api.sent) == 1
    assert (em["status"], em["numero"]) == ("issued", 128) and em["nfse_xml"].startswith("<?xml")


async def test_no_confirmation_keeps_the_number_and_retries(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})

    async def offline(signed: bytes) -> ApiResult:
        api.sent.append(signed)
        return ApiResult(status=0, detail="sem rede")

    api.emit = offline  # type: ignore[method-assign]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "queued" and j["error_code"] == "NFSE_UNAVAILABLE", repo.log_messages()  # tenta de novo sozinho
    assert em["status"] == "processing" and em["n_dps"] == 1 and em["send_started_at"] is not None


async def test_test_environment_note_stays_out_of_the_folder(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo, test_env=True)
    await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    before = len(repo.downloads)
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["last_message"].endswith("(ambiente de teste)."), repo.log_messages()
    assert api.test_env is True and "<tpAmb>2</tpAmb>" in api.sent[0].decode()
    assert em["status"] == "issued" and len(repo.downloads) == before


async def test_model_must_be_in_this_computers_folder(repo: FakeRepo, deps, api: FakeApi, tmp_path: Path) -> None:  # noqa: ANN001
    client, job, em = setup(repo)
    path = await seed(repo, tmp_path, client, {chave(127): nota(chave(127), numero=127)})
    path.unlink()
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert j["status"] == "failed" and "não está na pasta das notas" in j["error_message"], repo.log_messages()
    assert api.sent == []


# -- cancelamento ---------------------------------------------------------------------------------


def setup_cancel(repo: FakeRepo, **fields: Any):  # noqa: ANN201
    client = make_client()
    repo.add_client(client, make_certificate(client))
    job = repo.add_job(client, [TaskType.NFSE_CANCEL], competence=MES)
    key = chave(128, "2610")
    em = repo.add_emission(
        client, job, job_id=str(uuid.uuid4()), cancel_job_id=job.id, status="issued", chave=key, numero=128, amount="1500.00",
        cancel_status="requested", cancel_reason_code=1, cancel_reason="Valor combinado foi alterado", **fields,
    )
    return client, job, em, key


async def test_cancel_registers_the_event_and_marks_the_note(repo: FakeRepo, deps, api: FakeApi) -> None:  # noqa: ANN001
    client, job, em, key = setup_cancel(repo)
    await repo.upsert_notes([{"client_id": client.id, "document_type": "NFSE_PRESTADAS", "chave": key, "competence": MES}])
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert (j["status"], j["last_message"]) == ("completed", "NFS-e nº 128 cancelada."), repo.log_messages()
    ((sent_key, signed),) = api.events
    assert sent_key == key and f'Id="PRE{key}101101001"' in signed.decode() and "<tpAmb>1</tpAmb>" in signed.decode()
    assert (em["status"], em["cancel_status"]) == ("canceled", None) and em["canceled_at"] is not None
    assert repo.notes[0]["canceled"] is True


async def test_cancel_refused_keeps_the_note_issued(repo: FakeRepo, deps, api: FakeApi) -> None:  # noqa: ANN001
    client, job, em, key = setup_cancel(repo)
    api.event_errors = [{"codigo": "E0840", "mensagem": "Prazo para cancelamento encerrado"}]
    assert await SchedulerRunner(deps).run_once()
    j = repo.job(job.id)
    assert (j["status"], j["error_code"]) == ("failed", "NFSE_REJECTED"), repo.log_messages()
    assert (em["status"], em["cancel_status"], em["cancel_errors"]) == ("issued", "rejected", api.event_errors)


async def test_cancel_sent_twice_is_still_a_cancel(repo: FakeRepo, deps, api: FakeApi) -> None:  # noqa: ANN001
    client, job, em, key = setup_cancel(repo, test_env=True)
    api.event_errors = [{"codigo": "", "mensagem": "Nota fiscal não está ativa. Situação atual Cancelada"}]
    assert await SchedulerRunner(deps).run_once()
    assert repo.job(job.id)["status"] == "completed", repo.log_messages()
    assert em["status"] == "canceled" and api.test_env is True


# -- notas indexadas antes da 1.2.37 ----------------------------------------------------------------


async def test_old_index_rows_get_the_service_codes(repo: FakeRepo, deps, tmp_path: Path) -> None:  # noqa: ANN001
    client = make_client()
    repo.add_client(client)
    k1, k2 = chave(1), chave(2)
    path = await seed(repo, tmp_path, client, {k1: nota(k1, numero=1), k2: nota(k2, numero=2, simples="1")})
    for n in repo.notes:  # como o 1.2.36 gravava: sem os campos da emissão
        for campo in ("c_trib_nac", "c_trib_mun", "c_nbs", "servico_nome", "c_loc_emi", "emit_model"):
            n[campo] = None
    assert await evaluate_nfse_models(repo, path.parent, skip=set()) == 2
    notes = {n["chave"]: n for n in repo.notes}
    assert (notes[k1]["emit_model"], notes[k1]["c_trib_mun"], notes[k2]["emit_model"]) == ("ok", "040", "fora_simples")
    assert await evaluate_nfse_models(repo, path.parent, skip=set()) == 0
