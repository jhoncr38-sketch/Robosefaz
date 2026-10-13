// Consulta pública de CNPJ para o tomador novo da NFS-e: três fontes abertas com a base da Receita Federal,
// na ordem; a primeira que responder com nome e município vale. Nada daqui é guardado.

export interface CnpjRecord {
  nome: string;
  cmun: string;
  cidade: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  situacao: string;
}

type Json = Record<string, unknown>;

const text = (o: Json | undefined, k: string) => String(o?.[k] ?? "").trim();
const obj = (o: Json | undefined, k: string): Json => (o?.[k] && typeof o[k] === "object" ? (o[k] as Json) : {});

/** BrasilAPI e minhareceita.org devolvem o mesmo formato. */
export function fromBrasilApi(d: Json): CnpjRecord {
  return {
    nome: text(d, "razao_social"),
    cmun: text(d, "codigo_municipio_ibge"),
    cidade: [text(d, "municipio"), text(d, "uf")].filter(Boolean).join("/"),
    cep: text(d, "cep").replace(/\D/g, ""),
    logradouro: [text(d, "descricao_tipo_de_logradouro"), text(d, "logradouro")].filter(Boolean).join(" "),
    numero: text(d, "numero") || "S/N",
    complemento: text(d, "complemento"),
    bairro: text(d, "bairro"),
    situacao: text(d, "descricao_situacao_cadastral"),
  };
}

/** publica.cnpj.ws: os dados do estabelecimento vêm aninhados. */
export function fromCnpjWs(d: Json): CnpjRecord {
  const e = obj(d, "estabelecimento");
  return {
    nome: text(d, "razao_social"),
    cmun: text(obj(e, "cidade"), "ibge_id"),
    cidade: [text(obj(e, "cidade"), "nome"), text(obj(e, "estado"), "sigla")].filter(Boolean).join("/"),
    cep: text(e, "cep").replace(/\D/g, ""),
    logradouro: [text(e, "tipo_logradouro"), text(e, "logradouro")].filter(Boolean).join(" "),
    numero: text(e, "numero") || "S/N",
    complemento: text(e, "complemento"),
    bairro: text(e, "bairro"),
    situacao: text(e, "situacao_cadastral"),
  };
}

export const CNPJ_SOURCES: { name: string; url: (doc: string) => string; parse: (d: Json) => CnpjRecord }[] = [
  { name: "BrasilAPI", url: (doc) => `https://brasilapi.com.br/api/cnpj/v1/${doc}`, parse: fromBrasilApi },
  { name: "minhareceita.org", url: (doc) => `https://minhareceita.org/${doc}`, parse: fromBrasilApi },
  { name: "publica.cnpj.ws", url: (doc) => `https://publica.cnpj.ws/cnpj/${doc}`, parse: fromCnpjWs },
];

/** O registro serve quando traz o nome e o município (código IBGE de 7 números, que a prefeitura confere). */
export function usableRecord(r: CnpjRecord): boolean {
  return Boolean(r.nome) && /^\d{7}$/.test(r.cmun);
}
