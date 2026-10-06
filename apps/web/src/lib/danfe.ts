// Leitura do XML de uma NF-e/NFC-e para a visualização no painel (estilo DANFE).
// Sem DOMParser: funciona no servidor e nos testes. O XML da SEFAZ é bem-formado e sem
// repetição de tags no mesmo nível, então a leitura por trechos é segura.

export interface DanfeParty {
  nome: string;
  doc: string;
  ie: string;
  endereco: string;
  municipio: string;
  uf: string;
  cep: string;
  fone: string;
}

export interface DanfeItem {
  codigo: string;
  descricao: string;
  ncm: string;
  cst: string;
  cfop: string;
  unidade: string;
  quantidade: string;
  valorUnitario: string;
  valorTotal: string;
  aliqIcms: string;
}

export interface DanfeTotals {
  baseIcms: string;
  valorIcms: string;
  baseIcmsSt: string;
  valorIcmsSt: string;
  valorProdutos: string;
  frete: string;
  seguro: string;
  desconto: string;
  outras: string;
  ipi: string;
  tributos: string;
  valorNota: string;
}

export interface DanfeData {
  chave: string;
  modelo: string;
  serie: string;
  numero: string;
  emissao: string | null;
  /** 0 = entrada, 1 = saída */
  tipo: string;
  natureza: string;
  protocolo: string;
  protocoloEm: string | null;
  cStat: string;
  emitente: DanfeParty;
  destinatario: DanfeParty | null;
  totais: DanfeTotals;
  itens: DanfeItem[];
  transportadora: string;
  infAdic: string;
}

function block(src: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(src);
  return m ? m[1] : "";
}

function tag(src: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(src);
  return m ? decode(m[1].trim()) : "";
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function party(src: string, addressTag: string): DanfeParty | null {
  if (!src) return null;
  const end = block(src, addressTag);
  const parts = [tag(end, "xLgr"), tag(end, "nro")].filter(Boolean).join(", ");
  const extra = [tag(end, "xCpl"), tag(end, "xBairro")].filter(Boolean).join(" · ");
  return {
    nome: tag(src, "xNome"),
    doc: tag(src, "CNPJ") || tag(src, "CPF") || tag(src, "idEstrangeiro"),
    ie: tag(src, "IE"),
    endereco: [parts, extra].filter(Boolean).join(" · "),
    municipio: tag(end, "xMun"),
    uf: tag(end, "UF"),
    cep: tag(end, "CEP"),
    fone: tag(end, "fone"),
  };
}

export function parseDanfe(xml: string): DanfeData | null {
  const inf = block(xml, "infNFe");
  if (!inf) return null;
  const idMatch = /<infNFe\b[^>]*\bId="NFe(\d{44})"/.exec(xml);
  const ide = block(inf, "ide");
  const tot = block(block(inf, "total"), "ICMSTot");
  const prot = block(xml, "infProt");
  const itens: DanfeItem[] = [];
  const det = /<det\b[^>]*>([\s\S]*?)<\/det>/g;
  let m: RegExpExecArray | null;
  while ((m = det.exec(inf)) !== null) {
    const prod = block(m[1], "prod");
    const icms = block(block(m[1], "imposto"), "ICMS");
    const cst = tag(icms, "CST") || tag(icms, "CSOSN");
    itens.push({
      codigo: tag(prod, "cProd"),
      descricao: tag(prod, "xProd"),
      ncm: tag(prod, "NCM"),
      cst: cst ? `${tag(icms, "orig")}${cst}` : "",
      cfop: tag(prod, "CFOP"),
      unidade: tag(prod, "uCom"),
      quantidade: tag(prod, "qCom"),
      valorUnitario: tag(prod, "vUnCom"),
      valorTotal: tag(prod, "vProd"),
      aliqIcms: tag(icms, "pICMS"),
    });
  }
  const transp = block(block(inf, "transp"), "transporta");
  return {
    chave: idMatch ? idMatch[1] : "",
    modelo: tag(ide, "mod"),
    serie: tag(ide, "serie"),
    numero: tag(ide, "nNF"),
    emissao: tag(ide, "dhEmi") || tag(ide, "dEmi") || null,
    tipo: tag(ide, "tpNF"),
    natureza: tag(ide, "natOp"),
    protocolo: tag(prot, "nProt"),
    protocoloEm: tag(prot, "dhRecbto") || null,
    cStat: tag(prot, "cStat"),
    emitente: party(block(inf, "emit"), "enderEmit") ?? {
      nome: "",
      doc: "",
      ie: "",
      endereco: "",
      municipio: "",
      uf: "",
      cep: "",
      fone: "",
    },
    destinatario: party(block(inf, "dest"), "enderDest"),
    totais: {
      baseIcms: tag(tot, "vBC"),
      valorIcms: tag(tot, "vICMS"),
      baseIcmsSt: tag(tot, "vBCST"),
      valorIcmsSt: tag(tot, "vST"),
      valorProdutos: tag(tot, "vProd"),
      frete: tag(tot, "vFrete"),
      seguro: tag(tot, "vSeg"),
      desconto: tag(tot, "vDesc"),
      outras: tag(tot, "vOutro"),
      ipi: tag(tot, "vIPI"),
      tributos: tag(tot, "vTotTrib"),
      valorNota: tag(tot, "vNF"),
    },
    itens,
    transportadora: tag(transp, "xNome"),
    infAdic: tag(block(inf, "infAdic"), "infCpl"),
  };
}

const money = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });

/** "4837.5" -> "4.837,50"; vazio -> "0,00". */
export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && value !== "" && value != null ? money.format(n) : "0,00";
}

export function formatQty(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) && value !== "" ? qty.format(n) : value;
}

/** 12.345.678/0001-90 ou 123.456.789-00. */
export function formatDoc(doc: string): string {
  const d = doc.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc;
}

/** "000.012.345" como na DANFE. */
export function formatNoteNumber(n: string | number): string {
  return String(n).padStart(9, "0").replace(/(\d{3})(?=\d)/g, "$1.");
}
