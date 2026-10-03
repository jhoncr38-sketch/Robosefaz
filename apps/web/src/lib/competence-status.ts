// Situação de cada cliente numa competência, a partir do job mais recente dele.
// Usado no Dashboard (barra da competência) e na Automação (quem pode ser agendado).

import type { Tone } from "@/lib/status";
import type { JobStatus } from "@/lib/types";

export type ClientCompetenceStatus =
  | "done"
  | "queued"
  | "running"
  | "sefaz"
  | "attention"
  | "failed"
  | "cancelled"
  | "none";

export const COMPETENCE_STATUS_LABEL: Record<ClientCompetenceStatus, string> = {
  done: "Concluído",
  queued: "Na fila",
  running: "Processando",
  sefaz: "Aguardando SEFAZ",
  attention: "Intervenção",
  failed: "Erro",
  cancelled: "Cancelado",
  none: "Não solicitado",
};

export const COMPETENCE_STATUS_TONE: Record<Exclude<ClientCompetenceStatus, "none">, Tone> = {
  done: "green",
  queued: "slate",
  running: "blue",
  sefaz: "yellow",
  attention: "orange",
  failed: "red",
  cancelled: "gray",
};

/** Cor da barra segmentada e da legenda (mesma ordem de exibição). */
export const COMPETENCE_STATUS_COLOR: Record<ClientCompetenceStatus, string> = {
  done: "#2ea062",
  queued: "#64748b",
  running: "#3b82e0",
  sefaz: "#e0a019",
  attention: "#f97316",
  failed: "#dc3b3b",
  cancelled: "#a3a39e",
  none: "#e3e3de",
};

export const COMPETENCE_STATUS_ORDER: ClientCompetenceStatus[] = [
  "done",
  "queued",
  "running",
  "sefaz",
  "attention",
  "failed",
  "cancelled",
  "none",
];

export function competenceStatusOf(job: { status: JobStatus } | null | undefined): ClientCompetenceStatus {
  if (!job) return "none";
  switch (job.status) {
    case "completed":
      return "done";
    case "queued":
      return "queued";
    case "waiting_sefaz":
    case "checking_processing":
    case "download_available":
    case "downloading":
    case "organizing_files":
      return "sefaz";
    case "manual_action_required":
    case "waiting_certificate":
    case "certificate_required":
      return "attention";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/**
 * Já existe pedido válido para a competência: um novo agendamento seria ignorado
 * pelo banco (a mesma regra de create_automation_job). Erro e cancelado podem ser reagendados.
 */
export function blocksNewRequest(status: ClientCompetenceStatus): boolean {
  return status !== "none" && status !== "failed" && status !== "cancelled";
}

/** Agendamento de notas (a consulta de EFD não conta na situação da competência). */
const REGULAR_EXPORTS = ["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"];

/** Trabalho de exportação das notas ativas (não EFD, malhas nem só as canceladas). */
export function isExportJob(job: { operations?: readonly string[] | null }): boolean {
  if (!job.operations) return true; // consulta sem as operações: como antes
  return job.operations.some((op) => REGULAR_EXPORTS.includes(op));
}

/** Job mais recente de cada cliente na competência. */
export function latestJobByClient<T extends { client_id: string; competence: string; created_at: string }>(
  jobs: T[],
  competence: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const job of jobs) {
    if (job.competence !== competence) continue;
    const cur = map.get(job.client_id);
    if (!cur || job.created_at > cur.created_at) map.set(job.client_id, job);
  }
  return map;
}

export function countByStatus(statuses: ClientCompetenceStatus[]): Record<ClientCompetenceStatus, number> {
  const out = Object.fromEntries(COMPETENCE_STATUS_ORDER.map((s) => [s, 0])) as Record<ClientCompetenceStatus, number>;
  for (const s of statuses) out[s] += 1;
  return out;
}

export type CompetenceStatusMap = Record<string, ClientCompetenceStatus>;

/** Situação de cada cliente na competência (clientes sem job ficam de fora = "Não solicitado"). */
export function statusMapFromJobs(
  jobs: { client_id: string; competence: string; status: JobStatus; created_at: string }[],
  competence: string,
): CompetenceStatusMap {
  const out: CompetenceStatusMap = {};
  for (const [clientId, job] of latestJobByClient(jobs, competence)) out[clientId] = competenceStatusOf(job);
  return out;
}

/** Os 4 grupos da barra da competência no Dashboard (a cor só muda onde pede ação). */
export type CompetenceGroupKey = "done" | "progress" | "problem" | "none";

export interface CompetenceGroup {
  key: CompetenceGroupKey;
  label: string;
  n: number;
  /** quadradinho da legenda */
  color: string;
  /** trecho da barra ("Não solicitado" é o próprio fundo) */
  fill: string;
  sub: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function parts(items: [number, string][]): string {
  return items
    .filter(([n]) => n > 0)
    .map(([, text]) => text)
    .join(" · ");
}

export function competenceGroups(c: Record<ClientCompetenceStatus, number>): CompetenceGroup[] {
  return [
    {
      key: "done",
      label: "Concluído",
      n: c.done,
      color: "#2ea062",
      fill: "#2ea062",
      sub: c.done > 0 ? "todos os documentos baixados" : "nenhum ainda",
    },
    {
      key: "progress",
      label: "Em andamento",
      n: c.queued + c.running + c.sefaz,
      color: "#e0a019",
      fill: "#e0a019",
      sub:
        parts([
          [c.queued, `${c.queued} na fila`],
          [c.running, `${c.running} no robô`],
          [c.sefaz, `${c.sefaz} SEFAZ`],
        ]) || "nada em andamento",
    },
    {
      key: "problem",
      label: "Com problema",
      n: c.failed + c.attention,
      color: "#dc3b3b",
      fill: "#dc3b3b",
      sub:
        parts([
          [c.failed, plural(c.failed, "erro", "erros")],
          [c.attention, plural(c.attention, "intervenção", "intervenções")],
        ]) || "nenhum",
    },
    {
      key: "none",
      label: "Não solicitado",
      n: c.none + c.cancelled,
      color: "#d4d4cf",
      fill: "transparent",
      sub:
        parts([
          [c.none, `${c.none} sem pedido`],
          [c.cancelled, plural(c.cancelled, "cancelado", "cancelados")],
        ]) || "todos solicitados",
    },
  ];
}
