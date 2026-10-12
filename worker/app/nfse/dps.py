"""DPS e pedido de cancelamento da NFS-e (leiaute nacional v1.01), a partir de uma nota real do cliente.

A nota nova copia de uma NFS-e que a prefeitura já aceitou o que não pode ser inventado: o cadastro
do prestador (inscrição municipal, regime), o serviço (códigos nacional, municipal e NBS) e a
tributação. Só mudam o tomador, a descrição, o valor e a competência — o que a pessoa conferiu no
painel. Os trechos copiados vão como estão no XML de origem, sem reescrever.

Nem toda nota serve de modelo: `model_status` diz se serve para qualquer tomador ("ok"), só para o
tomador da própria nota ("mesmo_tomador": obra ou ISS retido valem para aquele tomador) ou o motivo
de não servir (empresa fora do Simples, valores de imposto que teriam de ser recalculados...).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from xml.sax.saxutils import escape

from app.jobs.errors import AutomationError, ErrorCode

NS = "http://www.sped.fazenda.gov.br/nfse"
# série reservada às notas enviadas pela API (10001 a 49999); as do site da prefeitura usam 00001 a 10000
API_SERIE = "10001"
APP_NAME = "JRSistema"
TERESINA = "2211001"
CANCEL_EVENT = "101101"
# sem horário de verão: Teresina é sempre UTC-3
TZ_BR = timezone(timedelta(hours=-3))

MODEL_OK = "ok"
MODEL_SAME_TAKER = "mesmo_tomador"
USABLE_MODELS = frozenset({MODEL_OK, MODEL_SAME_TAKER})

MODEL_REASONS = {
    "sem_dps": "a nota não traz a DPS de origem",
    "outro_municipio": "a nota não foi emitida por Teresina",
    "emissor_nacional": "a nota foi emitida pelo emissor nacional, não pela prefeitura",
    "fora_simples": "empresa fora do Simples Nacional (ME/EPP)",
    "ibs_cbs": "a nota tem dados de IBS/CBS além dos códigos (destinatário, imóvel ou valores)",
    "valores_de_imposto": "a nota tem valores de imposto ou retenção que precisariam ser recalculados",
    "desconto_ou_deducao": "a nota tem desconto ou dedução",
    "intermediario": "a nota tem intermediário",
    "emitente_nao_prestador": "a nota não foi emitida pelo próprio prestador",
    "nao_tributavel": "a operação não é tributável normalmente (imunidade, exportação ou não incidência)",
    "servico_especial": "o serviço tem dados próprios (evento, locação, comércio exterior ou pedágio)",
}

_SPECIAL_SERVICE = re.compile(r"<(comExt|lsadppu|atvEvento|explRod)[ >]")
# grupo de IBS/CBS que a DPS pode levar sem valores: só os códigos (os valores quem calcula é a prefeitura)
_IBS_SIMPLE = re.compile(
    r"^<IBSCBS><finNFSe>\d</finNFSe>(?:<indFinal>\d</indFinal>)?<cIndOp>(\d{6})</cIndOp>(?:<indDest>\d</indDest>)?"
    r"<valores><trib><gIBSCBS><CST>(\d{3})</CST><cClassTrib>(\d{6})</cClassTrib></gIBSCBS></trib></valores></IBSCBS>$"
)
_MONEY = re.compile(r"<v[A-Z]\w*>")


def tag(name: str, src: str) -> str:
    m = re.search(rf"<{name}>([^<]*)</{name}>", src)
    return m.group(1).strip() if m else ""


def block(name: str, src: str) -> str:
    m = re.search(rf"<{name}[ >].*?</{name}>", src, re.S)
    return m.group(0) if m else ""


def digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def party_doc(src: str) -> str:
    return tag("CNPJ", src) or tag("CPF", src) or tag("NIF", src)


def without_contact(src: str) -> str:
    """E-mail e telefone não vão na nota nova: a prefeitura não precisa deles para emitir."""
    return re.sub(r"<(email|fone)>[^<]*</\1>", "", src)


def note_key(nfse_xml: str) -> str | None:
    m = re.search(r'<infNFSe[^>]*\sId="NFS(\d{50})"', nfse_xml)
    return m.group(1) if m else None


def key_number(chave: str) -> str:
    """Número da NFS-e tirado da própria chave: município (7) + ambiente (1) + tipo de inscrição (1) +
    CNPJ/CPF (14) + número (13) + ano e mês (4) + código (9) + dígito (1). Vazio se a chave não tem 50 números."""
    return str(int(chave[23:36])) if re.fullmatch(r"\d{50}", chave or "") else ""


def ibs_codes(dps_or_note: str) -> dict[str, str] | None:
    """CST, cClassTrib e indicador da operação do grupo simples de IBS/CBS da DPS; None se não há ou não é simples."""
    dps = block("infDPS", dps_or_note) or dps_or_note
    m = _IBS_SIMPLE.match(re.sub(r">\s+<", "><", block("IBSCBS", dps)))
    return {"ind_op": m.group(1), "cst": m.group(2), "class_trib": m.group(3)} if m else None


def ibs_block(codes: dict[str, str]) -> str:
    """Grupo de IBS/CBS como o site da prefeitura grava: nota regular, destinatário = tomador, só os códigos."""
    cst, class_trib, ind_op = digits(codes.get("cst")), digits(codes.get("class_trib")), digits(codes.get("ind_op"))
    if len(cst) != 3 or len(class_trib) != 6 or len(ind_op) != 6:
        raise _invalid("IBS/CBS: informe o CST (3 números), o cClassTrib (6) e o indicador da operação (6).")
    return (
        f"<IBSCBS><finNFSe>0</finNFSe><cIndOp>{ind_op}</cIndOp><indDest>0</indDest>"
        f"<valores><trib><gIBSCBS><CST>{cst}</CST><cClassTrib>{class_trib}</cClassTrib></gIBSCBS></trib></valores></IBSCBS>"
    )


def dps_id(cnpj: str, numero: int, *, serie: str = API_SERIE, municipio: str = TERESINA) -> str:
    """Id da DPS: município (7) + tipo de inscrição (2 = CNPJ) + CNPJ (14) + série (5) + número (15)."""
    return f"DPS{municipio}2{cnpj}{serie.zfill(5)}{int(numero):015d}"


def model_status(nfse_xml: str) -> str:
    """Se a NFS-e serve de modelo para emitir pelo sistema. -> "ok", "mesmo_tomador" ou o motivo."""
    dps = block("infDPS", nfse_xml)
    if not dps:
        return "sem_dps"
    if tag("cLocEmi", dps) != TERESINA:
        return "outro_municipio"
    if tag("ambGer", nfse_xml.split("<DPS", 1)[0]) != "1":
        return "emissor_nacional"
    if tag("opSimpNac", block("prest", dps)) != "3":
        return "fora_simples"
    if "<IBSCBS" in dps and ibs_codes(dps) is None:
        return "ibs_cbs"
    valores = block("valores", dps)
    trib = block("trib", valores)
    if _MONEY.search(trib):
        return "valores_de_imposto"
    if re.search(r"<(vDescCondIncond|vDedRed)[ >]", valores):
        return "desconto_ou_deducao"
    if "<interm" in dps:
        return "intermediario"
    if tag("tpEmit", dps) not in ("", "1"):
        return "emitente_nao_prestador"
    if tag("tribISSQN", trib) != "1":
        return "nao_tributavel"
    serv = block("serv", dps)
    if _SPECIAL_SERVICE.search(serv):
        return "servico_especial"
    if "<obra" in serv or tag("tpRetISSQN", trib) in ("2", "3"):
        return MODEL_SAME_TAKER
    return MODEL_OK


def describe_model_status(status: str) -> str:
    return MODEL_REASONS.get(status, status)


def _invalid(message: str) -> AutomationError:
    return AutomationError(ErrorCode.INVALID_CONFIGURATION, message)


def now_br(now: datetime | None = None) -> datetime:
    """Hora da emissão: dois minutos atrás, para o relógio deste computador nunca ficar à frente do da prefeitura."""
    base = now or datetime.now(TZ_BR)
    return (base.astimezone(TZ_BR) - timedelta(minutes=2)).replace(microsecond=0)


@dataclass(slots=True)
class DpsRequest:
    """O que a pessoa conferiu no painel, mais as notas de onde o resto é copiado."""

    cnpj: str  # prestador (só números)
    numero: int
    amount: Decimal
    description: str
    competence: str  # AAAA-MM
    model_xml: str  # serviço e tributação
    prest_xml: str  # nota mais recente do cliente: cadastro atual do prestador
    taker_xml: str | None = None  # nota de onde copiar o tomador
    taker: dict[str, Any] | None = None  # tomador novo
    test_env: bool = False
    now: datetime | None = None
    # atividade informada à mão no painel (None = a da nota-modelo)
    c_trib_nac: str | None = None
    c_trib_mun: str | None = None
    # NBS e IBS/CBS como conferidos no painel: None = como na nota-modelo; vazio = a nota vai sem
    c_nbs: str | None = None
    ibs: dict[str, str] | None = None


def _new_taker(t: dict[str, Any]) -> str:
    doc = re.sub(r"[^0-9A-Za-z]", "", str(t.get("doc") or ""))
    nome = " ".join(str(t.get("nome") or "").split())
    cmun, cep = digits(t.get("cmun")), digits(t.get("cep"))
    lgr, nro, bairro = (" ".join(str(t.get(k) or "").split()) for k in ("logradouro", "numero", "bairro"))
    cpl = " ".join(str(t.get("complemento") or "").split())
    if len(doc) not in (11, 14) or not nome or len(cmun) != 7 or len(cep) != 8 or not (lgr and nro and bairro):
        raise _invalid("Dados do tomador novo incompletos (CNPJ/CPF, nome, município, CEP, logradouro, número e bairro).")
    kind = "CNPJ" if len(doc) == 14 else "CPF"
    return (
        f"<toma><{kind}>{doc}</{kind}><xNome>{escape(nome)}</xNome>"
        f"<end><endNac><cMun>{cmun}</cMun><CEP>{cep}</CEP></endNac><xLgr>{escape(lgr)}</xLgr><nro>{escape(nro)}</nro>"
        + (f"<xCpl>{escape(cpl)}</xCpl>" if cpl else "")
        + f"<xBairro>{escape(bairro)}</xBairro></end></toma>"
    )


def build_dps(req: DpsRequest) -> tuple[str, str]:
    """XML da DPS (sem assinatura) e o Id dela."""
    model = block("infDPS", req.model_xml)
    status = model_status(req.model_xml)
    if status not in USABLE_MODELS:
        raise _invalid(f"A nota-modelo não serve para emitir pelo sistema: {describe_model_status(status)}.")
    cnpj = digits(req.cnpj)
    if len(cnpj) != 14 or tag("CNPJ", block("prest", model)) != cnpj:
        raise _invalid("A nota-modelo não é deste cliente (CNPJ do prestador diferente).")
    prest = block("prest", block("infDPS", req.prest_xml)) or block("prest", model)
    if tag("CNPJ", prest) != cnpj:
        prest = block("prest", model)
    prest = without_contact(prest)

    if req.taker_xml is not None:
        toma = without_contact(block("toma", block("infDPS", req.taker_xml)))
        if not toma:
            raise _invalid("A nota de onde o tomador seria copiado não tem tomador.")
    elif req.taker:
        toma = _new_taker(req.taker)
    else:
        toma = ""
    if status == MODEL_SAME_TAKER and party_doc(toma) != party_doc(block("toma", model)):
        raise _invalid("Este serviço (obra ou ISS retido) só pode ser repetido para o mesmo tomador da nota-modelo.")

    description = " ".join(str(req.description or "").split())
    if not (3 <= len(description) <= 2000):
        raise _invalid("Descrição do serviço ausente ou longa demais.")
    amount = Decimal(req.amount).quantize(Decimal("0.01"))
    if not (Decimal("0") < amount < Decimal("100000000")):
        raise _invalid("Valor da nota inválido.")
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", req.competence or ""):
        raise _invalid("Competência inválida.")

    serv = block("serv", model)
    if not serv or not tag("cTribNac", serv) or not tag("cTribMun", serv):
        raise _invalid("A nota-modelo não tem os códigos nacional e municipal do serviço.")
    serv = re.sub(r"<xDescServ>[^<]*</xDescServ>", lambda _m: f"<xDescServ>{escape(description)}</xDescServ>", serv)
    serv = re.sub(r"<infoCompl>.*?</infoCompl>", "", serv, flags=re.S)
    if req.c_trib_nac is not None or req.c_trib_mun is not None:
        # outra atividade do cadastro da empresa: só troca os códigos; a prefeitura recusa o que não estiver no cadastro
        nac, mun = digits(req.c_trib_nac), digits(req.c_trib_mun)
        if len(nac) != 6 or len(mun) != 3:
            raise _invalid("Atividade: informe o código nacional (6 números) e o municipal (3 números).")
        if status != MODEL_OK:
            raise _invalid("Para informar outra atividade, a nota-modelo precisa valer para qualquer tomador (sem obra nem ISS retido).")
        serv = re.sub(r"<cTribNac>[^<]*</cTribNac>", f"<cTribNac>{nac}</cTribNac>", serv)
        serv = re.sub(r"<cTribMun>[^<]*</cTribMun>", f"<cTribMun>{mun}</cTribMun>", serv)
    if req.c_nbs is not None:
        nbs = digits(req.c_nbs)
        if nbs and len(nbs) != 9:
            raise _invalid("O código NBS tem 9 números.")
        serv = re.sub(r"<cNBS>[^<]*</cNBS>", "", serv)
        if nbs:
            serv = serv.replace("</xDescServ>", f"</xDescServ><cNBS>{nbs}</cNBS>", 1)
    model_ibs = ibs_codes(model)
    if req.ibs is not None:
        ibs = ibs_block(req.ibs) if any(digits(v) for v in req.ibs.values()) else ""
    else:
        ibs = ibs_block(model_ibs) if model_ibs else ""
    trib = block("trib", block("valores", model))
    if not trib:
        raise _invalid("A nota-modelo não tem o grupo de tributação.")

    issued = now_br(req.now)
    competence_day = f"{req.competence}-01"
    if competence_day > issued.date().isoformat():
        raise _invalid("A competência não pode ser posterior à data da emissão.")
    ident = dps_id(cnpj, req.numero)
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<DPS xmlns="{NS}" versao="1.01"><infDPS Id="{ident}">'
        f"<tpAmb>{2 if req.test_env else 1}</tpAmb><dhEmi>{issued.isoformat()}</dhEmi><verAplic>{APP_NAME}</verAplic>"
        f"<serie>{API_SERIE}</serie><nDPS>{int(req.numero)}</nDPS><dCompet>{competence_day}</dCompet>"
        f"<tpEmit>1</tpEmit><cLocEmi>{TERESINA}</cLocEmi>{prest}{toma}{serv}"
        f"<valores><vServPrest><vServ>{amount}</vServ></vServPrest>{trib}</valores>{ibs}"
        "</infDPS></DPS>"
    )
    return re.sub(r">\s+<", "><", xml), ident


def build_cancel(chave: str, cnpj: str, reason_code: int, reason: str, *, test_env: bool, now: datetime | None = None) -> str:
    """Pedido de registro do evento de cancelamento (sem assinatura)."""
    if not re.fullmatch(r"\d{50}", chave or ""):
        raise _invalid("Chave de acesso da NFS-e inválida.")
    cnpj = digits(cnpj)
    reason = " ".join(str(reason or "").split())
    if reason_code not in (1, 2, 9) or not (15 <= len(reason) <= 255) or len(cnpj) != 14:
        raise _invalid("Motivo do cancelamento inválido.")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<pedRegEvento xmlns="{NS}" versao="1.01"><infPedReg Id="PRE{chave}{CANCEL_EVENT}001">'
        f"<tpAmb>{2 if test_env else 1}</tpAmb><verAplic>{APP_NAME}</verAplic><dhEvento>{now_br(now).isoformat()}</dhEvento>"
        f"<CNPJAutor>{cnpj}</CNPJAutor><chNFSe>{chave}</chNFSe><nPedRegEvento>1</nPedRegEvento>"
        f"<e{CANCEL_EVENT}><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>{reason_code}</cMotivo>"
        f"<xMotivo>{escape(reason)}</xMotivo></e{CANCEL_EVENT}>"
        "</infPedReg></pedRegEvento>"
    )
