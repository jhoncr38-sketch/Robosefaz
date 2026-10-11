// DANFSe no modelo nacional: Nota Técnica SE/CGNFS-e nº 008/2026, v1.01 (Anexo I, "DANFSe v2.0").
// Desde 15/07/2026 a API do governo que gerava o PDF está suspensa: quem emite a nota monta o DANFSe.
//
// Regras da nota técnica seguidas aqui: uma página A4 em retrato; só o que está no XML da NFS-e; campo
// sem informação leva um traço; "NFS-e SEM VALIDADE JURÍDICA" em vermelho quando a nota é do ambiente
// de teste; marca-d'água "CANCELADA" ou "SUBSTITUÍDA" na diagonal; QR Code da consulta pública pela
// chave. O canhoto é opcional e não é impresso (o espaço vai para a descrição e as informações
// complementares).
//
// Devolve o HTML da página inteira (com o CSS de impressão), para abrir numa aba e imprimir ou
// salvar em PDF. Este arquivo traz a tabela de municípios do IBGE: importe-o só sob demanda.

import qrcode from "qrcode-generator";

import { block, tag } from "./danfe.ts";
import { MUNICIPIOS } from "./ibge-municipios.ts";

const CONSULTA = "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=";

const AMB_GER: Record<string, string> = { "1": "Prefeitura", "2": "Sefin Nacional NFS-e" };
const TP_AMB: Record<string, string> = { "1": "Produção", "2": "Homologação" };
const EMITENTE: Record<string, string> = { "1": "Prestador", "2": "Tomador", "3": "Intermediário" };
const SITUACAO: Record<string, string> = {
  "100": "NFS-e Gerada",
  "101": "NFS-e de Substituição Gerada",
  "102": "NFS-e de Decisão Judicial ou Administrativa",
  "103": "NFS-e Avulsa",
};
const FINALIDADE: Record<string, string> = { "0": "NFS-e regular" };
const SIMPLES: Record<string, string> = {
  "1": "Não Optante",
  "2": "Optante - Microempreendedor Individual (MEI)",
  "3": "Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)",
};
const REGIME_SN: Record<string, string> = {
  "1": "Regime de apuração dos tributos federais e municipal pelo Simples Nacional",
  "2": "Regime de apuração dos tributos federais pelo SN e o ISSQN pela NFS-e conforme respectiva legislação municipal do tributo",
  "3": "Regime de apuração dos tributos federais e municipal pela NFS-e conforme respectivas legislações federal e municipal de cada tributo",
};
const TRIB_ISSQN: Record<string, string> = { "1": "Operação Tributável", "2": "Imunidade", "3": "Exportação de Serviço", "4": "Não Incidência" };
const RETENCAO: Record<string, string> = { "1": "Não Retido", "2": "Retido pelo Tomador", "3": "Retido pelo Intermediário" };
const REG_ESPECIAL: Record<string, string> = {
  "0": "Nenhum",
  "1": "Ato Cooperado (Cooperativa)",
  "2": "Estimativa",
  "3": "Microempresa Municipal",
  "4": "Notário ou Registrador",
  "5": "Profissional Autônomo",
  "6": "Sociedade de Profissionais",
  "9": "Outros",
};
const IMUNIDADE: Record<string, string> = {
  "1": "Patrimônio, renda ou serviços, uns dos outros",
  "2": "Templos de qualquer culto",
  "3": "Patrimônio, renda ou serviços dos partidos políticos, entidades sindicais, instituições de educação e de assistência social",
  "4": "Livros, jornais, periódicos e o papel destinado a sua impressão",
  "5": "Fonogramas e videofonogramas musicais produzidos no Brasil",
};
const SUSPENSAO: Record<string, string> = {
  "1": "Exigibilidade Suspensa por Decisão Judicial",
  "2": "Exigibilidade Suspensa por Processo Administrativo",
};
const BENEFICIO: Record<string, string> = { "1": "Isenção", "2": "Redução da Base de Cálculo", "3": "Redução da Base de Cálculo", "4": "Alíquota Diferenciada" };

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const label = (map: Record<string, string>, code: string) => map[code] ?? code;

function cut(text: string, limit: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : `${t.slice(0, limit - 3).trimEnd()}...`;
}

function money(value: string | number): string {
  if (value === "" || value === null || value === undefined) return "";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "";
}

function pct(value: string): string {
  const n = Number(value);
  return value !== "" && Number.isFinite(n) ? `${n.toFixed(2).replace(".", ",")} %` : "";
}

function doc(d: string): string {
  if (/^\d{14}$/.test(d)) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (/^\d{11}$/.test(d)) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return d;
}

const date = (d: string) => (d.length >= 10 ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
const dateTime = (d: string) => (d.length >= 19 ? `${date(d)} ${d.slice(11, 19)}` : date(d));
const cep = (c: string) => (/^\d{8}$/.test(c) ? `${c.slice(0, 2)}.${c.slice(2, 5)}-${c.slice(5)}` : c);
const nbs = (c: string) => (/^\d{9}$/.test(c) ? `${c[0]}.${c.slice(1, 5)}.${c.slice(5, 7)}.${c.slice(7)}` : c);

function serviceCode(nac: string, mun: string): string {
  const n = nac.length === 6 ? `${nac.slice(0, 2)}.${nac.slice(2, 4)}.${nac.slice(4)}` : nac;
  return [n, mun].filter(Boolean).join(" / ");
}

/** "Nome / UF" a partir do código IBGE (a nota técnica manda usar a descrição do código). */
function city(code: string, country = ""): string {
  if (!code) return "";
  const [name, uf] = (MUNICIPIOS[code] ?? "").split("/");
  return [name || "-", uf || "-", country].filter(Boolean).join(" / ");
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

function cell(rotulo: string, valor = "", span = 1, classe = ""): string {
  return `<div class="c ${classe}" style="grid-column:span ${span}"><span class="r">${esc(rotulo)}</span><span class="v">${esc(valor || "-")}</span></div>`;
}
const title = (text: string) => `<div class="c t">${esc(text)}</div>`;
const row = (...cells: string[]) => `<div class="l">${cells.join("")}</div>`;
const group = (content: string) => `<div class="bloco">${content}</div>`;
const single = (text: string) => `<div class="bloco u">${esc(text)}</div>`;

export interface DanfseOptions {
  cancelada?: boolean;
  substituida?: boolean;
  /** endereço do logotipo da NFS-e (a nota técnica pede o logotipo no canto esquerdo do cabeçalho) */
  logoUrl?: string;
}

/** HTML completo do DANFSe da NFS-e. null se o XML não for de uma NFS-e no leiaute nacional. */
export function danfseNacionalHtml(xml: string, options: DanfseOptions = {}): string | null {
  const inf = block(xml, "infNFSe");
  const dps = block(block(inf, "DPS"), "infDPS");
  if (!inf || !dps) return null;
  const head = inf.split("<DPS")[0];
  const emit = block(head, "emit");
  const prest = block(dps, "prest");
  const toma = block(dps, "toma");
  const interm = block(dps, "interm");
  const serv = block(dps, "serv");
  const cServ = block(serv, "cServ");
  const ibsDps = block(dps, "IBSCBS");
  const ibsNf = block(head, "IBSCBS") || block(inf.split("</DPS>")[1] ?? "", "IBSCBS");
  const vNf = block(head, "valores");
  const vDps = block(dps, "valores");
  const tribMun = block(block(vDps, "trib"), "tribMun");
  const tribFed = block(block(vDps, "trib"), "tribFed");
  const chave = (/<infNFSe[^>]*\sId="[A-Z]*(\d{50})"/.exec(xml)?.[1] ?? "").trim();
  const numero = tag(head, "nNFSe");
  const teste = tag(dps, "tpAmb") === "2";

  const person = (heading: string, src: string, withIm = true, fallback = ""): string => {
    const end = block(src, "end") || block(fallback, "enderNac");
    const nac = block(end, "endNac") || end;
    const ext = block(end, "endExt");
    const cmun = tag(nac, "cMun");
    const place = cmun ? city(cmun) : tag(ext, "xCidade");
    const post = cep(tag(nac, "CEP")) || tag(ext, "cEndPost");
    const address = [tag(end, "xLgr"), tag(end, "nro"), tag(end, "xCpl"), tag(end, "xBairro")].filter(Boolean).join(", ");
    const get = (name: string) => tag(src, name) || tag(fallback, name);
    return (
      row(
        title(heading),
        cell("CNPJ / CPF / NIF", doc(tag(src, "CNPJ") || tag(src, "CPF") || tag(src, "NIF"))),
        withIm ? cell("Indicador Municipal (Inscrição)", get("IM")) : '<div class="c"></div>',
        cell("Telefone", get("fone")),
      ) +
      row(cell("Nome / Nome Empresarial", cut(get("xNome"), 80), 2), cell("Município / Sigla UF", cut(place, 40)), cell("Código IBGE / CEP", [cmun, post].filter(Boolean).join(" / "))) +
      row(cell("Endereço", cut(address, 80), 2), cell("E-mail", cut(get("email"), 80), 2))
    );
  };

  // ---------- cabeçalho e identificação ----------
  const emitCity = city(tag(dps, "cLocEmi")) || tag(head, "xLocEmi");
  const header =
    `<div class="cab"><div class="logo">${options.logoUrl ? `<img alt="NFS-e" src="${esc(options.logoUrl)}">` : ""}</div>` +
    `<div class="meio"><div>DANFSe v2.0</div><div>Documento Auxiliar da NFS-e</div>${teste ? '<div class="sv">NFS-e SEM VALIDADE JURÍDICA</div>' : ""}</div>` +
    `<div class="dir"><b>Município: ${esc(emitCity)}</b>Ambiente Gerador: ${esc(label(AMB_GER, tag(head, "ambGer")))}<br>` +
    `Tipo de Ambiente: ${esc(label(TP_AMB, tag(dps, "tpAmb")))}</div></div>`;
  const ident = (rotulo: string, valor: string, x: number, y: number, classe = "", width = 5.09) =>
    `<div class="i ${classe}" style="left:${x}cm;top:${y}cm;width:${width}cm"><span>${esc(rotulo)}</span><b>${esc(valor || "-")}</b></div>`;
  const identification =
    '<div class="ident">' +
    ident("CHAVE DE ACESSO DA NFS-E", chave, 0, 0, "", 15.3) +
    ident("NÚMERO DA NFS-E", numero, 0, 0.79) +
    ident("COMPETÊNCIA DA NFS-E", date(tag(dps, "dCompet")), 5.11, 0.79) +
    ident("DATA E HORA DA EMISSÃO DA NFS-E", dateTime(tag(head, "dhProc")), 10.21, 0.79) +
    ident("NÚMERO DA DPS", tag(dps, "nDPS"), 0, 1.48) +
    ident("SÉRIE DA DPS", tag(dps, "serie"), 5.11, 1.48) +
    ident("DATA E HORA DA EMISSÃO DA DPS", dateTime(tag(dps, "dhEmi")), 10.21, 1.48) +
    ident("EMITENTE DA NFS-e", label(EMITENTE, tag(dps, "tpEmit")), 0, 2.17, "cinza") +
    ident("SITUAÇÃO DA NFS-e", cut(label(SITUACAO, tag(head, "cStat")), 40), 5.11, 2.17) +
    ident("FINALIDADE", cut(label(FINALIDADE, tag(ibsDps, "finNFSe")), 40), 10.21, 2.17) +
    (chave ? qrSvg(CONSULTA + chave) : "") +
    '<div class="qrt">A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e</div>' +
    "</div>";

  // ---------- partes ----------
  const prestDoc = tag(prest, "CNPJ") || tag(prest, "CPF");
  const sameEmit = Boolean(emit) && prestDoc === (tag(emit, "CNPJ") || tag(emit, "CPF"));
  const reg = block(prest, "regTrib");
  const provider = group(
    person("PRESTADOR / FORNECEDOR", prest, true, sameEmit ? emit : "") +
      row(
        cell("Simples Nacional na Data de Competência", cut(label(SIMPLES, tag(reg, "opSimpNac")), 40)),
        cell("Regime de Apuração Tributária pelo SN", cut(label(REGIME_SN, tag(reg, "regApTribSN")), 80), 3),
      ),
  );
  const taker = toma ? group(person("TOMADOR / ADQUIRENTE", toma)) : single("TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");
  const dest = block(ibsDps, "dest");
  const recipient = dest
    ? group(person("DESTINATÁRIO DA OPERAÇÃO", dest, false))
    : ibsDps && tag(ibsDps, "indDest") === "0" && toma
      ? single("O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO")
      : single("DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");
  const intermediary = interm ? group(person("INTERMEDIÁRIO DA OPERAÇÃO", interm)) : single("INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e");

  // ---------- serviço ----------
  const locPrest = block(serv, "locPrest");
  const place = tag(locPrest, "cLocPrestacao");
  const service =
    '<div class="bloco serv">' +
    row(
      title("SERVIÇO PRESTADO"),
      cell("Código de Tributação Nacional / Municipal", serviceCode(tag(cServ, "cTribNac"), tag(cServ, "cTribMun"))),
      cell("Código da NBS", nbs(tag(cServ, "cNBS"))),
      cell("Local da Prestação / Sigla UF / País", cut(place ? city(place, tag(locPrest, "cPaisPrestacao") || "BR") : tag(locPrest, "cPaisPrestacao"), 42)),
    ) +
    `<div class="dc">${esc(cut(tag(head, "xTribMun") || tag(head, "xTribNac"), 170) || "-")}</div>` +
    `<div class="ds"><span class="r">Descrição do Serviço</span><span class="v">${esc(cut(tag(cServ, "xDescServ"), 1300) || "-")}</span></div></div>`;

  // ---------- tributação municipal ----------
  let municipal: string;
  if (!tribMun) {
    municipal = single("TRIBUTAÇÃO MUNICIPAL (ISSQN) - OPERAÇÃO NÃO SUJEITA AO ISSQN");
  } else {
    const incid = tag(head, "cLocIncid");
    const exig = block(tribMun, "exigSusp");
    const benefit = [
      label(BENEFICIO, tag(vNf, "tpBM")),
      money(tag(vNf, "vCalcBM") || tag(block(tribMun, "BM"), "vRedBCBM")),
      money(tag(vNf, "vCalcDR")),
      money(tag(block(vDps, "vDescCondIncond"), "vDescIncond")),
    ];
    municipal = group(
      row(
        title("TRIBUTAÇÃO MUNICIPAL (ISSQN)"),
        cell("Tipo de Tributação do ISSQN", label(TRIB_ISSQN, tag(tribMun, "tribISSQN"))),
        cell("Município / Sigla UF / País de Incidência do ISSQN", cut(incid ? city(incid, tag(tribMun, "cPaisResult") || "BR") : "", 42), 2),
      ) +
        row(
          cell("Regime Especial de Tributação do ISSQN", label(REG_ESPECIAL, tag(reg, "regEspTrib"))),
          cell("Tipo de Imunidade do ISSQN", cut(label(IMUNIDADE, tag(tribMun, "tpImunidade")), 40)),
          cell("Suspensão da Exigibilidade do ISSQN", cut(label(SUSPENSAO, tag(exig, "tpSusp")), 40)),
          cell("Número Processo Suspensão", tag(exig, "nProcesso")),
        ) +
        (benefit.some(Boolean)
          ? row(cell("Benefício Municipal", benefit[0]), cell("Cálculo do BM", benefit[1]), cell("Total Deduções/Reduções", benefit[2]), cell("Desconto Incondicionado", benefit[3]))
          : "") +
        row(
          cell("BC ISSQN", money(tag(vNf, "vBC"))),
          cell("Alíquota Aplicada", pct(tag(vNf, "pAliqAplic"))),
          cell("Retenção do ISSQN", label(RETENCAO, tag(tribMun, "tpRetISSQN"))),
          cell("ISSQN Apurado", money(tag(vNf, "vISSQN"))),
        ),
    );
  }

  // ---------- tributação federal ----------
  const pis = block(tribFed, "piscofins");
  const federal = group(
    row(
      title("TRIBUTAÇÃO FEDERAL (EXCETO CBS)"),
      cell("IRRF", money(tag(tribFed, "vRetIRRF"))),
      cell("Contribuição Previdenciária - Retida", money(tag(tribFed, "vRetCP"))),
      cell("Contribuições Sociais – Retidas", money(tag(tribFed, "vRetCSLL"))),
    ) +
      // linha impressa para notas com competência até o fim de 2026 (nota 6 da nota técnica)
      (tag(dps, "dCompet").slice(0, 4) <= "2026"
        ? row(
            cell("PIS - Débito Apuração Própria", money(tag(pis, "vPis"))),
            cell("COFINS - Débito Apuração Própria", money(tag(pis, "vCofins"))),
            cell("Descrição Contrib. Sociais – Retidas", tag(pis, "tpRetPisCofins"), 2),
          )
        : ""),
  );

  // ---------- IBS / CBS ----------
  const gi = block(block(block(ibsDps, "valores"), "trib"), "gIBSCBS");
  const vi = block(ibsNf, "valores");
  const tot = block(ibsNf, "totCIBS");
  const gIbs = block(tot, "gIBS");
  const incidIbs = tag(ibsNf, "cLocalidadeIncid");
  const sum = (values: string[]) => {
    const nums = values.filter((v) => v !== "").map(Number).filter(Number.isFinite);
    return nums.length ? money(nums.reduce((a, b) => a + b, 0)) : "";
  };
  const ibs = group(
    row(
      title("TRIBUTAÇÃO IBS / CBS"),
      cell("CST / cClassTrib", [tag(gi, "CST"), tag(gi, "cClassTrib")].filter(Boolean).join(" / ")),
      cell(
        "Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF",
        cut([tag(ibsDps, "cIndOp"), incidIbs, incidIbs ? city(incidIbs) : ""].filter(Boolean).join(" / "), 56),
        2,
      ),
    ) +
      row(
        cell(
          "Exclusões e Reduções da Base de Cálculo",
          ibsNf ? sum([tag(block(vDps, "vDescCondIncond"), "vDescIncond"), tag(vi, "vCalcReeRepRes"), tag(vNf, "vISSQN"), tag(pis, "vPis"), tag(pis, "vCofins")]) : "",
        ),
        cell("Base de Cálculo Após Exclusões e Reduções", money(tag(vi, "vBC"))),
        cell("Red. Alíquota IBS / Red. Alíquota CBS", [tag(block(vi, "uf"), "pRedAliqUF"), tag(block(vi, "mun"), "pRedAliqMun"), tag(block(vi, "fed"), "pRedAliqCBS")].filter(Boolean).map(pct).join(" / ")),
        cell("Alíquota – IBS UF / IBS Mun", [tag(block(vi, "uf"), "pIBSUF"), tag(block(vi, "mun"), "pIBSMun")].filter(Boolean).map(pct).join(" / ")),
      ) +
      row(
        cell("Alíq. Efetiva Municipal – IBS", pct(tag(block(vi, "mun"), "pAliqEfetMun"))),
        cell("Valor Apurado Municipal – IBS", money(tag(block(gIbs, "gIBSMunTot"), "vIBSMun"))),
        cell("Alíq. Efetiva Estadual – IBS", pct(tag(block(vi, "uf"), "pAliqEfetUF"))),
        cell("Valor Apurado Estadual – IBS", money(tag(block(gIbs, "gIBSUFTot"), "vIBSUF"))),
      ) +
      row(
        cell("Valor Total Apurado – IBS", money(tag(gIbs, "vIBSTot"))),
        cell("Alíquota - CBS", pct(tag(block(vi, "fed"), "pCBS"))),
        cell("Alíquota Efetiva – CBS", pct(tag(block(vi, "fed"), "pAliqEfetCBS"))),
        cell("Valor Total Apurado – CBS", money(tag(block(tot, "gCBS"), "vCBS"))),
      ),
  );

  // ---------- valor total ----------
  const desc = block(vDps, "vDescCondIncond");
  const total =
    '<div class="bloco total">' +
    row(
      title("VALOR TOTAL DA NFS-E"),
      cell("VALOR DA OPERAÇÃO / SERVIÇO", money(tag(block(vDps, "vServPrest"), "vServ")), 1, "d"),
      cell("Desconto Incondicionado", money(tag(desc, "vDescIncond"))),
      cell("Desconto Condicionado", money(tag(desc, "vDescCond"))),
    ) +
    row(
      cell("Total das Retenções (ISSQN / Federais)", money(tag(vNf, "vTotalRet"))),
      cell("VALOR LÍQUIDO DA NFS-e", money(tag(vNf, "vLiq")), 1, "d"),
      cell("Total do IBS/CBS", sum([tag(gIbs, "vIBSTot"), tag(block(tot, "gCBS"), "vCBS")])),
      cell("VALOR LÍQUIDO DA NFS-e + IBS/CBS", money(tag(tot, "vTotNF")), 1, "d cinza"),
    ) +
    "</div>";

  // ---------- informações complementares ----------
  const compl = block(serv, "infoCompl");
  const obra = block(serv, "obra");
  const items: [string, string][] = [
    ["Inf. Cont.:", tag(compl, "xInfComp")],
    ["NFS-e Subst.:", tag(block(dps, "subst"), "chSubstda")],
    ["Doc. Ref.:", tag(compl, "docRef")],
    ["Cod. Obra:", tag(obra, "cObra")],
    ["Insc. Imob.:", tag(obra, "inscImobFisc") || tag(block(ibsDps, "imovel"), "inscImobFisc")],
    ["Cod. Evt.:", tag(block(serv, "atvEvento"), "idAtvEvt")],
    ["Doc. Tec.:", tag(compl, "idDocTec")],
    ["Núm. Ped.:", tag(compl, "xPed")],
    ["Inf. A. T. Mun.:", tag(head, "xOutInf")],
  ];
  const extra = cut(items.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" | "), 2000);
  const totTrib = block(block(vDps, "trib"), "totTrib");
  const vTot = block(totTrib, "vTotTrib");
  const pTot = block(totTrib, "pTotTrib");
  const approx = vTot
    ? ["Fed", "Est", "Mun"].map((k) => money(tag(vTot, `vTotTrib${k}`)) || "-")
    : pTot
      ? ["Fed", "Est", "Mun"].map((k) => pct(tag(pTot, `pTotTrib${k}`)) || "-")
      : ["-", "-", "-"];
  const simples = tag(totTrib, "pTotTribSN");
  const totals = simples
    ? `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: ${pct(simples)} (Simples Nacional)`
    : `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ${approx[0]}; Estaduais: ${approx[1]}; Municipais: ${approx[2]}`;
  const info =
    '<div class="bloco info"><div class="tt">INFORMAÇÕES COMPLEMENTARES</div>' +
    (extra ? `<div class="tx">${esc(extra)}</div>` : "") +
    `<div class="tx">${esc(totals)}</div></div>`;

  const mark = options.cancelada ? "CANCELADA" : options.substituida ? "SUBSTITUÍDA" : "";
  return (
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFSe ${esc(numero)}</title><style>${CSS}</style></head><body>` +
    '<div class="barra"><button onclick="window.print()">Imprimir ou salvar em PDF</button>' +
    "<span>Modelo nacional do DANFSe (Nota Técnica nº 008/2026). Na impressão, escolha papel A4 e margens “Nenhuma”.</span></div>" +
    `<div class="pg"><div class="borda"></div>${mark ? `<div class="marca">${mark}</div>` : ""}` +
    `<div class="corpo">${header}${identification}${provider}${taker}${recipient}${intermediary}${service}${municipal}${federal}${ibs}${total}${info}</div></div></body></html>`
  );
}

// medidas e fontes da nota técnica: rótulos em Arial (6 pt; 7 pt nos títulos e na identificação),
// conteúdo em Microsoft Sans Serif 7 pt, borda de 1 pt, linhas de 0,5 pt, cinza de 5% no cabeçalho e nos títulos
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#e9edf1}
.barra{background:#12263f;color:#fff;padding:10px 16px;display:flex;gap:14px;align-items:center;font:13px "Segoe UI",Arial,sans-serif}
.barra button{font:inherit;font-weight:600;padding:7px 14px;border-radius:6px;border:0;background:#f2b632;color:#3a2a00;cursor:pointer;white-space:nowrap}
.pg{width:21cm;height:29.7cm;background:#fff;position:relative;padding:.3cm;color:#000;font:7pt "Microsoft Sans Serif",Arial,Helvetica,sans-serif;overflow:hidden}
.borda{position:absolute;top:.17cm;left:.17cm;right:.17cm;bottom:.17cm;border:1pt solid #000;pointer-events:none}
.corpo{position:relative;height:100%;display:flex;flex-direction:column}
.cab{flex:none;height:1.16cm;background:#f2f2f2;display:grid;grid-template-columns:5.11cm 10.19cm 5.1cm}
.cab img{display:block;width:4cm;height:.85cm;margin:.14cm 0 0 .19cm;object-fit:contain;object-position:left center;mix-blend-mode:multiply}
.cab .meio{text-align:center;font:bold 9pt/1.12 Arial,Helvetica,sans-serif;display:flex;flex-direction:column;justify-content:center}
.cab .sv{color:#f00}
.cab .dir{font-size:6pt;line-height:.24cm;padding:0 .05cm 0 0;overflow:hidden}
.cab .dir b{display:block;font-weight:normal;font-size:8pt;line-height:1.12;height:.66cm;padding-top:.04cm;overflow:hidden}
.ident{flex:none;position:relative;height:2.86cm}
.ident .i{position:absolute;height:.67cm;padding:.06cm .08cm 0;overflow:hidden;white-space:nowrap}
.ident .i span{display:block;font:bold 7pt Arial,Helvetica,sans-serif}
.ident .i b{display:block;font-weight:normal;margin-top:.05cm}
.cinza{background:#f2f2f2}
.qr{position:absolute;left:17.18cm;top:.19cm;width:1.52cm;height:1.52cm}
.qrt{position:absolute;left:15.5cm;top:1.86cm;width:4.72cm;font-size:6pt;line-height:1.18;text-align:justify}
.bloco{flex:none;border-top:.5pt solid #000}
.l{display:grid;grid-template-columns:5.11cm 5.1cm 5.11cm 5.08cm;min-height:.645cm}
.c{padding:.05cm .08cm .02cm;min-width:0;overflow:hidden}
.c .r{display:block;font:bold 6pt Arial,Helvetica,sans-serif;white-space:nowrap;overflow:hidden}
.c .v{display:block;margin-top:.04cm;overflow-wrap:anywhere}
.c.t{background:#f2f2f2;font:bold 7pt Arial,Helvetica,sans-serif;text-transform:uppercase;padding-top:.08cm}
.c.d .r{font-size:7pt}
.u{text-align:center;height:.34cm;line-height:.33cm;white-space:nowrap}
.serv{flex:1.25 1 0;min-height:1.7cm;display:flex;flex-direction:column}
.serv .l{flex:none}
.dc{flex:none;min-height:.38cm;padding:.05cm .08cm 0}
.ds{flex:1;min-height:.63cm;padding:.05cm .08cm;overflow:hidden}
.ds .r{display:block;font:bold 6pt Arial,Helvetica,sans-serif}
.ds .v{display:block;margin-top:.05cm;white-space:pre-wrap;overflow-wrap:anywhere}
.total .l{min-height:.67cm}
.info{flex:1 1 0;min-height:.8cm;overflow:hidden}
.info .tt{font:bold 7pt Arial,Helvetica,sans-serif;padding:.08cm .08cm .06cm}
.info .tx{padding:0 .08cm .08cm;overflow-wrap:anywhere}
.marca{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-45deg);font:normal 96pt Arial,Helvetica,sans-serif;color:#a6a6a6;opacity:.45;white-space:nowrap;pointer-events:none;z-index:5}
@page{size:A4;margin:0}
@media screen{.pg{margin:16px auto;box-shadow:0 2px 14px rgba(0,0,0,.2);zoom:1.25}}
@media print{body{background:#fff}.barra{display:none}.pg{margin:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
