// "Sem movimento": o SIAT processou o pedido e não havia notas no período ("Processado sem notas"
// ou ZIP vazio). O robô não salva arquivo nesses casos, só marca a tarefa (result.no_notes); a tela
// Downloads mostra uma linha própria, para ninguém achar que a empresa ficou sem agendar.

import { isEmptyZip } from "./downloads.ts";
import type { NoteCountRow } from "./note-count.ts";
import type { ClientRef, DocumentType, DownloadRow, TaskStatus } from "./types.ts";

/** Linha da visão downloads_no_movement (ou de uma tarefa do trabalho, na página do trabalho). */
export interface NoMovementRow {
  id: string;
  client_id: string;
  job_id: string;
  competence: string;
  document_type: DocumentType;
  /** quando o SIAT respondeu "sem notas" */
  checked_at: string;
  external_request_id: string | null;
  clients?: ClientRef | null;
}

export type DownloadEntry = { kind: "file"; at: string; d: DownloadRow } | { kind: "empty"; at: string; n: NoMovementRow };

/** Filtro "Situação" da tela Downloads. */
export type Situation = "com-notas" | "sem-movimento";

export const SITUATION_LABEL: Record<Situation, string> = {
  "com-notas": "Com notas",
  "sem-movimento": "Sem movimento",
};

export function parseSituation(value: unknown): Situation | undefined {
  return value === "com-notas" || value === "sem-movimento" ? value : undefined;
}

/** Arquivo com nota dentro (ZIP vazio antigo ou contado com 0 notas = sem movimento). */
export function hasNotes(d: Pick<DownloadRow, "filename" | "size" | "note_count">): boolean {
  return !isEmptyZip(d) && d.note_count !== 0;
}

/** Arquivos e "sem movimento" numa lista só, do mais recente para o mais antigo. */
export function downloadEntries(files: DownloadRow[], empty: NoMovementRow[], situation?: Situation): DownloadEntry[] {
  const entries: DownloadEntry[] = [];
  for (const d of files) {
    if (situation === "com-notas" && !hasNotes(d)) continue;
    if (situation === "sem-movimento" && hasNotes(d)) continue;
    entries.push({ kind: "file", at: d.downloaded_at, d });
  }
  if (situation !== "com-notas") for (const n of empty) entries.push({ kind: "empty", at: n.checked_at, n });
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** "Sem movimento" conta como mês com 0 notas no aviso de "mês para conferir". */
export function asZeroCount(n: NoMovementRow): NoteCountRow {
  return {
    id: n.id,
    client_id: n.client_id,
    document_type: n.document_type,
    competence: n.competence,
    note_count: 0,
    downloaded_at: n.checked_at,
  };
}

/** Tarefas de exportação de um trabalho que terminaram "sem notas" (página do trabalho). */
export function noMovementFromTasks(
  tasks: {
    id: string;
    job_id: string;
    client_id: string;
    competence: string;
    task_type: string;
    status: TaskStatus;
    document_type: DocumentType | null;
    finished_at: string | null;
    updated_at?: string | null;
    external_request_id: string | null;
    result: Record<string, unknown> | null;
  }[],
): NoMovementRow[] {
  return tasks
    .filter((t) => t.task_type.endsWith("_EXPORT") && t.status === "completed" && t.document_type && t.result?.no_notes === true)
    .map((t) => ({
      id: t.id,
      client_id: t.client_id,
      job_id: t.job_id,
      competence: t.competence,
      document_type: t.document_type as DocumentType,
      checked_at: t.finished_at ?? t.updated_at ?? "",
      external_request_id: t.external_request_id,
    }));
}

export interface MonthSummary {
  clients: number;
  /** cliente + tipo com arquivo com notas */
  withNotes: number;
  /** cliente + tipo que o SIAT respondeu sem notas */
  noMovement: number;
  /** cliente + tipo ainda sem resposta (na fila, aguardando a SEFAZ ou com erro) */
  waiting: number;
}

const WAITING: TaskStatus[] = ["pending", "running", "scheduled", "processed", "downloaded", "failed"];

/**
 * Resumo da competência: cada cliente + tipo de nota conta uma vez. Com arquivo com notas vale
 * "com notas"; senão, "sem movimento"; senão, se o último pedido ainda não terminou (ou deu erro),
 * "aguardando". Clientes inativos não entram em "aguardando".
 */
export function monthSummary(
  files: Pick<DownloadRow, "client_id" | "document_type" | "filename" | "size" | "note_count">[],
  empty: Pick<NoMovementRow, "client_id" | "document_type">[],
  tasks: { client_id: string; document_type: DocumentType | null; status: TaskStatus; created_at: string }[],
  inactive: Set<string> = new Set(),
): MonthSummary {
  const key = (r: { client_id: string; document_type: DocumentType | null }) => `${r.client_id}|${r.document_type}`;
  const notes = new Set(files.filter(hasNotes).map(key));
  const none = new Set([...files.filter((d) => !hasNotes(d)).map(key), ...empty.map(key)].filter((k) => !notes.has(k)));
  const latest = new Map<string, (typeof tasks)[number]>();
  for (const t of tasks) {
    if (!t.document_type) continue;
    const prev = latest.get(key(t));
    if (!prev || t.created_at > prev.created_at) latest.set(key(t), t);
  }
  const waiting = new Set(
    [...latest.entries()]
      .filter(([k, t]) => !notes.has(k) && !none.has(k) && WAITING.includes(t.status) && !inactive.has(t.client_id))
      .map(([k]) => k),
  );
  const clients = new Set([...notes, ...none, ...waiting].map((k) => k.split("|")[0]));
  return { clients: clients.size, withNotes: notes.size, noMovement: none.size, waiting: waiting.size };
}
