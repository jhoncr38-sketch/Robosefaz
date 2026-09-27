// Consulta do processamento da EFD: situação de cada cliente numa competência,
// a partir das declarações lidas no DT-e e das consultas pedidas ao robô.

import type { Tone } from "@/lib/status";
import type { EfdDeclaration, EfdSituation, JobStatus } from "@/lib/types";

export type EfdRowState = EfdSituation | "checking" | "no_message" | "check_failed" | "not_checked";

export const EFD_STATE_LABEL: Record<EfdRowState, string> = {
  processed: "Processada",
  alert: "Processada com malha",
  pending: "Processada com pendência",
  not_processed: "Não processada",
  checking: "Consultando",
  no_message: "Sem mensagem no DT-e",
  check_failed: "Erro na consulta",
  not_checked: "Não consultada",
};

export const EFD_STATE_TONE: Record<Exclude<EfdRowState, "not_checked">, Tone> = {
  processed: "green",
  alert: "yellow",
  pending: "orange",
  not_processed: "red",
  checking: "blue",
  no_message: "gray",
  check_failed: "red",
};

export const EFD_STATE_HINT: Partial<Record<EfdRowState, string>> = {
  alert: "Tipo 3: pode ser analisada por Auditor Fiscal",
  pending: "Tipo 2: regularizar em até 45 dias",
  not_processed: "Tipo 1: sem validade para a SEFAZ-PI",
  no_message: "EFD não entregue ou mensagem expirada",
};

export interface EfdCheckJob {
  id: string;
  client_id: string;
  status: JobStatus;
  created_at: string;
  last_message: string | null;
  error_message: string | null;
}

const FINAL: JobStatus[] = ["completed", "failed", "cancelled"];

/** Declaração que vale: a processada por último (a retificadora substitui a original). */
export function latestDeclaration(decls: EfdDeclaration[]): EfdDeclaration | null {
  if (decls.length === 0) return null;
  const key = (d: EfdDeclaration) => d.processed_at ?? d.received_at ?? d.checked_at;
  return [...decls].sort((a, b) => key(b).localeCompare(key(a)) || b.epe_number.localeCompare(a.epe_number))[0];
}

/**
 * Situação do cliente: consulta em andamento > declaração lida > resultado da última consulta.
 */
export function efdRowState(decls: EfdDeclaration[], jobs: EfdCheckJob[]): EfdRowState {
  const lastJob = [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (lastJob && !FINAL.includes(lastJob.status)) return "checking";
  const decl = latestDeclaration(decls);
  if (decl) return decl.situation;
  if (!lastJob) return "not_checked";
  if (lastJob.status === "completed") return "no_message";
  if (lastJob.status === "failed") return "check_failed";
  return "not_checked";
}

export function isProblem(state: EfdRowState): boolean {
  return state === "alert" || state === "pending" || state === "not_processed" || state === "check_failed";
}
