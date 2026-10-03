// Consulta do processamento da EFD: situação de cada cliente numa competência,
// a partir das declarações lidas no DT-e e das consultas pedidas ao robô.

import type { Tone } from "@/lib/status";
import type { EfdDeclaration, EfdSituation, JobStatus } from "@/lib/types";

import { zonedParts } from "./timezone.ts";

export type EfdRowState =
  | EfdSituation
  | "retif_rejected"
  | "checking"
  | "no_message"
  | "check_failed"
  | "not_checked";

export const EFD_STATE_LABEL: Record<EfdRowState, string> = {
  processed: "Processada",
  alert: "Processada com malha",
  pending: "Processada com pendência",
  not_processed: "Não processada",
  retif_rejected: "Retificadora não processada",
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
  retif_rejected: "red",
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
 * Retificadora rejeitada não substitui nada: devolve a declaração processada que continua valendo.
 */
export function stillValidAfterRejectedRetif(decls: EfdDeclaration[]): EfdDeclaration | null {
  const decl = latestDeclaration(decls);
  if (!decl || decl.situation !== "not_processed" || (decl.finalidade ?? "").toUpperCase() !== "RETIFICADORA") return null;
  return latestDeclaration(decls.filter((d) => d.situation !== "not_processed"));
}

/**
 * Situação do cliente: consulta em andamento > declaração lida > resultado da última consulta.
 */
export function efdRowState(decls: EfdDeclaration[], jobs: EfdCheckJob[]): EfdRowState {
  const lastJob = [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (lastJob && !FINAL.includes(lastJob.status)) return "checking";
  const decl = latestDeclaration(decls);
  if (decl && stillValidAfterRejectedRetif(decls)) return "retif_rejected";
  if (decl) return decl.situation;
  if (!lastJob) return "not_checked";
  if (lastJob.status === "completed") return "no_message";
  if (lastJob.status === "failed") return "check_failed";
  return "not_checked";
}

export function isProblem(state: EfdRowState): boolean {
  return (
    state === "alert" ||
    state === "pending" ||
    state === "not_processed" ||
    state === "retif_rejected" ||
    state === "check_failed"
  );
}

/** Abas da tela (cada situação numa só; "Consultando" fica só em Todos). */
export type EfdTab = "all" | "not_processed" | "pending" | "missing" | "processed";

export function efdTab(state: EfdRowState): Exclude<EfdTab, "all"> | null {
  switch (state) {
    case "not_processed":
    case "retif_rejected":
      return "not_processed";
    case "pending":
    case "alert":
      return "pending";
    case "not_checked":
    case "no_message":
    case "check_failed":
      return "missing";
    case "processed":
      return "processed";
    default:
      return null;
  }
}

/** Ordem das linhas: o mais grave primeiro. */
export const EFD_SEVERITY: EfdRowState[] = [
  "not_processed",
  "retif_rejected",
  "pending",
  "alert",
  "check_failed",
  "no_message",
  "not_checked",
  "checking",
  "processed",
];

/** Prazo para regularizar a pendência (Tipo 2): 45 dias depois do processamento. */
export const PENDING_DAYS = 45;

export interface EfdHint {
  text: string;
  tone: "muted" | "danger" | "warn";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function dayMonth(iso: string): string {
  const p = zonedParts(new Date(iso));
  return `${pad2(p.day)}/${pad2(p.month)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Linha curta embaixo da situação: resumo das inconsistências por tipo, o prazo da pendência,
 * qual declaração continua valendo ou o erro da consulta.
 */
export function efdHint(
  state: EfdRowState,
  decls: EfdDeclaration[],
  lastJob: Pick<EfdCheckJob, "error_message" | "last_message"> | null | undefined,
  now = new Date(),
): EfdHint | null {
  if (state === "retif_rejected") {
    const valid = stillValidAfterRejectedRetif(decls);
    if (!valid) return null;
    const when = valid.processed_at ? ` de ${dayMonth(valid.processed_at)}` : "";
    return { text: `vale a ${(valid.finalidade ?? "declaração").toLowerCase()}${when}`, tone: "danger" };
  }
  if (state === "check_failed") {
    const msg = lastJob?.error_message || lastJob?.last_message || "erro na consulta";
    return { text: `${msg} · tente de novo`, tone: "danger" };
  }
  if (state === "checking" || state === "not_checked") return null;
  const decl = latestDeclaration(decls);
  const incs = decl?.inconsistencies ?? [];
  if (decl && incs.length > 0) {
    const by = (t: number) => incs.filter((i) => i.type === t).length;
    const parts = [
      by(1) ? count(by(1), "impeditiva", "impeditivas") : "",
      by(2) ? count(by(2), "pendência", "pendências") : "",
      by(3) ? count(by(3), "alerta", "alertas") : "",
    ].filter(Boolean);
    if (by(2) && decl.processed_at) {
      const deadline = Date.parse(decl.processed_at) + PENDING_DAYS * 86_400_000;
      const days = Math.ceil((deadline - now.getTime()) / 86_400_000);
      const iso = new Date(deadline).toISOString();
      parts.push(days >= 0 ? `até ${dayMonth(iso)} · ${count(days, "dia", "dias")}` : `prazo venceu em ${dayMonth(iso)}`);
    }
    return { text: parts.join(" · "), tone: by(1) ? "danger" : by(2) ? "warn" : "muted" };
  }
  const fixed = EFD_STATE_HINT[state];
  return fixed ? { text: fixed, tone: "muted" } : null;
}
