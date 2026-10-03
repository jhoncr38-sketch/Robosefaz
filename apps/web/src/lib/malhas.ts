// Consulta de Malhas Fiscais: situação de cada cliente a partir da última leitura
// da página "Consulta de Malhas" do SIAT e das consultas pedidas ao robô.

import type { Tone } from "@/lib/status";
import type { JobStatus, MalhaCheck, MalhaSource } from "@/lib/types";

export type MalhaRowState = "clean" | "findings" | "checking" | "check_failed" | "not_checked";

export const MALHA_STATE_LABEL: Record<MalhaRowState, string> = {
  clean: "Sem malha",
  findings: "Com malha",
  checking: "Consultando",
  check_failed: "Erro na consulta",
  not_checked: "Não consultada",
};

export const MALHA_STATE_TONE: Record<Exclude<MalhaRowState, "not_checked">, Tone> = {
  clean: "green",
  findings: "red",
  checking: "blue",
  check_failed: "red",
};

export const MALHA_SOURCE_LABEL: Record<MalhaSource, string> = {
  DIEF_PGDAS: "DIEF/PGDAS",
  EFD_OIE: "EFD/OIE",
};

export interface MalhaCheckJob {
  id: string;
  client_id: string;
  status: JobStatus;
  created_at: string;
  last_message: string | null;
  error_message: string | null;
}

const FINAL: JobStatus[] = ["completed", "failed", "cancelled"];

export function latestJob(jobs: MalhaCheckJob[]): MalhaCheckJob | null {
  return [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/**
 * Situação do cliente: consulta em andamento > última consulta com erro depois da
 * última leitura > leitura (com ou sem malha) > nunca consultado.
 */
export function malhaRowState(check: MalhaCheck | null, jobs: MalhaCheckJob[]): MalhaRowState {
  const last = latestJob(jobs);
  if (last && !FINAL.includes(last.status)) return "checking";
  if (last?.status === "failed" && (!check || check.checked_at < last.created_at)) return "check_failed";
  if (check) return check.total > 0 ? "findings" : "clean";
  return "not_checked";
}

export function isProblem(state: MalhaRowState): boolean {
  return state === "findings" || state === "check_failed";
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? BRL.format(n) : "—";
}

export function malhasLabel(total: number): string {
  return total === 1 ? "1 malha" : `${total} malhas`;
}

/** Abas da tela ("Consultando" fica só em Todos). */
export type MalhaTab = "all" | "findings" | "check_failed" | "not_checked" | "clean";

/** Ordem das linhas: com malha (maior ICMS primeiro), erro, não consultado, consultando, sem malha. */
const MALHA_ORDER: MalhaRowState[] = ["findings", "check_failed", "not_checked", "checking", "clean"];

export function compareMalhaRows(
  a: { state: MalhaRowState; icms: number; name: string },
  b: { state: MalhaRowState; icms: number; name: string },
): number {
  return (
    MALHA_ORDER.indexOf(a.state) - MALHA_ORDER.indexOf(b.state) ||
    b.icms - a.icms ||
    a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
  );
}

/** "2 malhas · Omissão de entradas NF-e e mais 1". */
export function findingsSummary(check: Pick<MalhaCheck, "total" | "findings">): string {
  const first = check.findings[0]?.identification;
  if (!first) return malhasLabel(check.total);
  const more = check.findings.length - 1;
  return `${malhasLabel(check.total)} · ${first}${more > 0 ? ` e mais ${more}` : ""}`;
}
