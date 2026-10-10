// Leitura do XML de uma NFS-e Nacional (leiaute do ADN) para a visualização no painel (estilo DANFSe).
// Mesma leitura por trechos da DANFE: o XML é bem-formado e a ordem é fixa (emit e valores da NFS-e
// vêm antes da DPS, que tem prestador, tomador, serviço e os valores informados).

import { block, tag } from "./danfe.ts";

export interface DanfseParty {
  nome: string;
  doc: string;
  im: string;
  endereco: string;
  municipio: string;
  uf: string;
  cep: string;
  email: string;
}

export interface DanfseData {
  chave: string;
  numero: string;
  serieDps: string;
  numeroDps: string;
  emissao: string | null;
  competencia: string;
  cStat: string;
  prestador: DanfseParty;
  tomador: DanfseParty | null;
  /** "Optante pelo Simples Nacional (ME/EPP)" etc. */
  simples: string;
  servico: {
    codigo: string;
    descricaoCodigo: string;
    descricao: string;
    localPrestacao: string;
    localIncidencia: string;
  };
  valores: {
    servico: string;
    baseCalculo: string;
    aliquota: string;
    iss: string;
    issRetido: boolean;
    retencoes: string;
    liquido: string;
  };
}

const SIMPLES: Record<string, string> = {
  "1": "Não optante pelo Simples Nacional",
  "2": "Optante pelo Simples Nacional (MEI)",
  "3": "Optante pelo Simples Nacional (ME/EPP)",
};

function party(src: string, name = ""): DanfseParty {
  const end = block(src, "end") || block(src, "enderNac");
  const nac = block(end, "endNac") || end;
  return {
    nome: name || tag(src, "xNome"),
    doc: tag(src, "CNPJ") || tag(src, "CPF") || tag(src, "NIF"),
    im: tag(src, "IM"),
    endereco: [tag(end, "xLgr"), tag(end, "nro"), tag(end, "xCpl"), tag(end, "xBairro")].filter(Boolean).join(", "),
    municipio: tag(nac, "cMun"),
    uf: tag(nac, "UF") || tag(end, "UF"),
    cep: tag(nac, "CEP") || tag(end, "CEP"),
    email: tag(src, "email"),
  };
}

export function parseDanfse(xml: string): DanfseData | null {
  const inf = block(xml, "infNFSe");
  if (!inf) return null;
  const id = /<infNFSe[^>]*\sId="[A-Z]*(\d{50})"/.exec(xml);
  const emit = block(inf, "emit");
  const dps = block(inf, "infDPS");
  const prest = block(dps, "prest");
  const toma = block(dps, "toma");
  const serv = block(dps, "serv");
  const nfseValores = block(inf, "valores");
  const dpsValores = block(dps, "valores");
  const emitDoc = tag(emit, "CNPJ") || tag(emit, "CPF");
  const prestDoc = tag(prest, "CNPJ") || tag(prest, "CPF");
  // o emitente costuma ser o próprio prestador: o nome e o endereço vêm dele (e a cidade, do local de emissão)
  const prestador = emitDoc && emitDoc === prestDoc ? { ...party(emit), municipio: tag(inf, "xLocEmi") } : party(prest);
  const tomador = toma ? party(toma) : null;
  // o endereço nacional traz só o código IBGE do município: sem o nome, não mostra
  for (const p of [prestador, tomador]) if (p && /^\d+$/.test(p.municipio)) p.municipio = "";
  const retido = tag(block(dpsValores, "tribMun"), "tpRetISSQN");
  return {
    chave: id ? id[1] : "",
    numero: tag(inf, "nNFSe"),
    serieDps: tag(dps, "serie"),
    numeroDps: tag(dps, "nDPS"),
    emissao: tag(dps, "dhEmi") || tag(inf, "dhProc") || null,
    competencia: tag(dps, "dCompet"),
    cStat: tag(inf, "cStat"),
    prestador,
    tomador,
    simples: SIMPLES[tag(block(prest, "regTrib"), "opSimpNac")] ?? "",
    servico: {
      codigo: tag(serv, "cTribNac"),
      descricaoCodigo: tag(inf, "xTribNac"),
      descricao: tag(serv, "xDescServ"),
      localPrestacao: tag(inf, "xLocPrestacao"),
      localIncidencia: tag(inf, "xLocIncid"),
    },
    valores: {
      servico: tag(block(dpsValores, "vServPrest"), "vServ"),
      baseCalculo: tag(nfseValores, "vBC"),
      aliquota: tag(nfseValores, "pAliqAplic"),
      iss: tag(nfseValores, "vISSQN"),
      issRetido: retido === "2" || retido === "3",
      retencoes: tag(nfseValores, "vTotalRet"),
      liquido: tag(nfseValores, "vLiq"),
    },
  };
}
