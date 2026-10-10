// Tela NFS-e Nacional: situação de cada cliente (última busca, pedido em andamento, erro).

import type { Tone } from "./status.ts";
import type { JobStatus } from "./types.ts";

export interface NfseJob {
  id: string;
  client_id: string;
  status: JobStatus;
  created_at: string;
  finished_at: string | null;
  last_message: string | null;
  error_message: string | null;
}

export interface NfseCursor {
  client_id: string;
  last_nsu: number;
  fetched_at: string | null;
  last_documents: number;
}

/** fetching: na fila ou buscando; error: a última busca falhou; done: já buscou; never: nunca buscou. */
export type NfseRowState = "fetching" | "error" | "done" | "never";

export const NFSE_STATE_LABEL: Record<NfseRowState, string> = {
  fetching: "Buscando",
  error: "Com erro",
  done: "Em dia",
  never: "Nunca buscado",
};

export const NFSE_STATE_TONE: Record<NfseRowState, Tone> = {
  fetching: "blue",
  error: "red",
  done: "green",
  never: "gray",
};

/** Ordem na lista: o que pede atenção primeiro. */
export const NFSE_SEVERITY: NfseRowState[] = ["error", "never", "fetching", "done"];

const FINAL: JobStatus[] = ["completed", "failed", "cancelled"];
const FAILED: JobStatus[] = ["failed", "certificate_required"];

export function latestNfseJob(jobs: NfseJob[]): NfseJob | undefined {
  return [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

export function nfseRowState(cursor: NfseCursor | undefined, lastJob: NfseJob | undefined): NfseRowState {
  if (lastJob && !FINAL.includes(lastJob.status) && !FAILED.includes(lastJob.status)) return "fetching";
  if (lastJob && FAILED.includes(lastJob.status)) return "error";
  if (cursor?.fetched_at) return "done";
  return "never";
}

/** Uma frase sob a situação: o resultado da última busca ou o erro. */
export function nfseHint(state: NfseRowState, lastJob: NfseJob | undefined): string {
  if (state === "fetching") return lastJob?.status === "queued" ? "Na fila do robô" : (lastJob?.last_message ?? "Buscando");
  if (state === "error") return lastJob?.error_message ?? lastJob?.last_message ?? "A última busca falhou";
  if (state === "done") return lastJob?.status === "completed" ? (lastJob.last_message ?? "") : "";
  return "A primeira busca traz todo o histórico disponível na NFS-e Nacional";
}
