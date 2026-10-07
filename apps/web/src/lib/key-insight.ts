// O que uma chave de acesso revela quando a nota não está no índice: quem emitiu, qual nota é,
// se o emitente é cliente do escritório e quem pode ter recebido (para escolher o certificado).

import { isValidKey, keyParts } from "./nfe-key.ts";

export interface InsightClient {
  id: string;
  client_code: string;
  name: string;
  cnpj: string;
  uses_nfe_received: boolean;
  uses_nfe_issued: boolean;
  uses_nfce: boolean;
}

export type KeySituation =
  /** dígito verificador não confere */
  | "invalida"
  /** o emitente é cliente: nota emitida por ele */
  | "emitida-cliente"
  /** emitente de fora: algum cliente recebeu; a pessoa escolhe qual */
  | "recebida-escolher"
  /** NFC-e de quem não é cliente: não passa pelo escritório */
  | "nfce-fora";

export interface KeyInsight {
  key: string;
  valid: boolean;
  situation: KeySituation;
  modelo: string;
  modeloLabel: string;
  serie: number;
  numero: number;
  /** "08/2026" e "2026-08" */
  anoMes: string;
  competence: string;
  uf: string;
  emitCnpj: string;
  emitClient: InsightClient | null;
  /** clientes que já receberam notas desse emitente (pelo índice) */
  knownRecipients: InsightClient[];
  /** clientes que usam NF-e recebidas e ainda não têm as recebidas desse mês baixadas */
  missingRecipients: InsightClient[];
  /** os demais que usam NF-e recebidas */
  otherRecipients: InsightClient[];
  /** empresa sugerida para entrar no SIAT */
  preselected: string | null;
}

const digits = (s: string) => s.replace(/\D/g, "");

export function buildKeyInsight(
  key: string,
  clients: InsightClient[],
  /** client_id dos que já receberam notas desse emitente */
  recipientIds: Set<string>,
  /** client_id dos que já têm as NF-e recebidas desse mês baixadas */
  downloadedIds: Set<string>,
): KeyInsight | null {
  const parts = keyParts(key);
  if (!parts) return null;
  const k = digits(key);
  const valid = isValidKey(k);
  const emitClient = clients.find((c) => digits(c.cnpj) === parts.cnpjEmitente) ?? null;
  const receivers = clients.filter((c) => c.uses_nfe_received && c.id !== emitClient?.id);
  const known = receivers.filter((c) => recipientIds.has(c.id));
  const missing = receivers.filter((c) => !recipientIds.has(c.id) && !downloadedIds.has(c.id));
  const other = receivers.filter((c) => !recipientIds.has(c.id) && downloadedIds.has(c.id));
  const nfce = parts.modelo === "65";
  let situation: KeySituation;
  if (!valid) situation = "invalida";
  else if (emitClient) situation = "emitida-cliente";
  else if (nfce) situation = "nfce-fora";
  else situation = "recebida-escolher";
  return {
    key: k,
    valid,
    situation,
    modelo: parts.modelo,
    modeloLabel: nfce ? "NFC-e" : parts.modelo === "55" ? "NF-e" : `modelo ${parts.modelo}`,
    serie: parts.serie,
    numero: parts.numero,
    anoMes: parts.anoMes,
    competence: `${parts.anoMes.slice(3)}-${parts.anoMes.slice(0, 2)}`,
    uf: parts.uf,
    emitCnpj: parts.cnpjEmitente,
    emitClient,
    knownRecipients: known,
    missingRecipients: missing,
    otherRecipients: other,
    preselected: emitClient?.id ?? (known.length === 1 ? known[0].id : null),
  };
}

/**
 * O robô consegue buscar esta nota no SIAT? Só NF-e (modelo 55) com dígito certo, e quando há
 * uma empresa para entrar: o emitente (cliente) ou alguém que pode ter recebido. NFC-e não tem
 * busca pela chave no SIAT: ela vem junto com o mês.
 */
export function canSearchInSiat(insight: KeyInsight): boolean {
  if (!insight.valid || insight.modelo !== "55") return false;
  return insight.situation === "emitida-cliente" || insight.situation === "recebida-escolher";
}

/** Nome do estado pelo código IBGE que abre a chave. */
export const UF_NAME: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO", "21": "MA", "22": "PI", "23": "CE",
  "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA", "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
  "41": "PR", "42": "SC", "43": "RS", "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};
