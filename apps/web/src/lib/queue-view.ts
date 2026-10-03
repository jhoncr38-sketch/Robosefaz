// Fila de processamento: abas, ordem das linhas e textos curtos de tempo (regras puras, testáveis).

import { FINAL_JOB_STATUSES, isJobRunning, MANUAL_JOB_STATUSES } from "./status.ts";
import type { AutomationJob, JobStatus } from "./types.ts";

export type QueueTab = "active" | "waiting" | "manual" | "finished" | "all";

/** Aba pela URL (?aba=intervencao): a pílula "Robô esperando você" abre direto na Intervenção. */
const TAB_PARAM: Record<string, QueueTab> = {
  andamento: "active",
  sefaz: "waiting",
  intervencao: "manual",
  finalizados: "finished",
  todos: "all",
};

export function queueTabFromParam(value: string | string[] | undefined): QueueTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (v && TAB_PARAM[v]) || "active";
}

/** Etapas depois do agendamento: o robô terminou a parte dele e a SEFAZ processa. */
export const SEFAZ_STATUSES: JobStatus[] = [
  "waiting_sefaz",
  "checking_processing",
  "download_available",
  "downloading",
  "organizing_files",
];

export function isManual(job: Pick<AutomationJob, "status">): boolean {
  return MANUAL_JOB_STATUSES.includes(job.status) || job.status === "certificate_required";
}

export function queueMatches(tab: QueueTab, job: AutomationJob): boolean {
  switch (tab) {
    case "active":
      return job.status === "queued" || isJobRunning(job.status);
    case "waiting":
      return job.status === "waiting_sefaz";
    case "manual":
      return isManual(job);
    case "finished":
      return FINAL_JOB_STATUSES.includes(job.status);
    default:
      return true;
  }
}

/** Na fila: mesma ordem em que o robô pega (claim_next_job: next_attempt_at, created_at). */
function byQueueOrder(a: AutomationJob, b: AutomationJob): number {
  return a.next_attempt_at.localeCompare(b.next_attempt_at) || a.created_at.localeCompare(b.created_at);
}

/** "1º na fila", "2º na fila"... para cada job em "Na fila". */
export function queuePositions(jobs: AutomationJob[]): Map<string, number> {
  const queued = jobs.filter((j) => j.status === "queued").sort(byQueueOrder);
  return new Map(queued.map((j, i) => [j.id, i + 1]));
}

function group(job: AutomationJob): number {
  if (isManual(job)) return 0;
  if (job.status === "queued") return 2;
  if (SEFAZ_STATUSES.includes(job.status)) return 3;
  if (isJobRunning(job.status)) return 1;
  return 4; // finalizados
}

/**
 * Ordem das linhas: quem pede ação, quem está rodando (no topo), a fila numerada, quem espera a SEFAZ
 * há mais tempo e os finalizados mais recentes.
 */
export function sortQueue(jobs: AutomationJob[], waitingSince: Record<string, string> = {}): AutomationJob[] {
  return [...jobs].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 2) return byQueueOrder(a, b);
    if (ga === 3) {
      const sa = waitingSince[a.id] ?? a.updated_at;
      const sb = waitingSince[b.id] ?? b.updated_at;
      return sa.localeCompare(sb);
    }
    if (ga === 4) return (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at);
    return (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at);
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Duração de um trabalho finalizado: "45 s", "38 min", "1h05". */
export function shortDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}

/** Há quanto tempo: "agora", "há 26 min", "há 3h", "há 2h10". */
export function shortAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `há ${h}h` : `há ${h}h${pad(m % 60)}`;
}

/** Espera da SEFAZ acima disso ganha destaque na coluna Tempo. */
export const LATE_SEFAZ_MS = 2 * 3600_000;
