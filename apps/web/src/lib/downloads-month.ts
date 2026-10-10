// Tela Downloads (refino de 03/10/2026): uma linha por cliente no mês, com um bloco por tipo de nota.
// Cada bloco é o arquivo mais recente do tipo, o "sem movimento" do SIAT ou o pedido ainda sem resposta.

import { isEmptyZip } from "./downloads.ts";
import type { NoMovementRow } from "./no-movement.ts";
import type { NoteAlert } from "./note-count.ts";
import type { DocumentType, DownloadRow, TaskStatus } from "./types.ts";

/** Ordem dos blocos na linha: as notas do mês, as de serviço (NFS-e) e, depois, as canceladas. */
export const BLOCK_ORDER: DocumentType[] = [
  "NFCE",
  "NFE_EMITIDAS",
  "NFE_RECEBIDAS",
  "NFSE_PRESTADAS",
  "NFSE_TOMADAS",
  "NFCE_CANCELADAS",
  "NFE_EMITIDAS_CANCELADAS",
  "NFE_RECEBIDAS_CANCELADAS",
];

/** Chips de tipo do topo da lista. */
export type TypeFilter = "all" | "nfce" | "emit" | "receb" | "nfse" | "canc";

export function blockKey(doc: DocumentType): Exclude<TypeFilter, "all"> {
  if (doc.endsWith("_CANCELADAS")) return "canc";
  if (doc === "NFSE_PRESTADAS" || doc === "NFSE_TOMADAS") return "nfse";
  if (doc === "NFCE") return "nfce";
  return doc === "NFE_EMITIDAS" ? "emit" : "receb";
}

/** file: arquivo com notas; empty: sem movimento; queued / waiting / error: pedido ainda sem resposta. */
export type BlockState = "file" | "empty" | "queued" | "waiting" | "error";

/** Uma exportação do mesmo mês e tipo (o robô grava uma versão nova quando o conteúdo mudou). */
export interface FileVersion {
  id: string;
  filename: string;
  downloaded_at: string;
  note_count: number | null;
  size: number;
  /** veio de "Forçar reagendamento" (null: trabalho já apagado pela limpeza) */
  forced: boolean | null;
  drive_file_id: string | null;
  /** notas a mais (ou a menos) que a versão anterior; null quando não dá para comparar */
  delta: number | null;
}

export interface MonthBlock {
  id: string;
  doc: DocumentType;
  state: BlockState;
  /** notas no arquivo (null: o robô ainda não contou) */
  count: number | null;
  alert?: NoteAlert;
  file?: DownloadRow;
  /** todas as versões do arquivo no mês, da mais nova para a mais antiga (só em blocos com arquivo) */
  versions?: FileVersion[];
}

/** Versões de um mesmo mês e tipo, da mais nova para a mais antiga, com a diferença de notas. */
export function fileVersions(rows: DownloadRow[], forcedByJob: Record<string, boolean> = {}): FileVersion[] {
  const sorted = [...rows].sort((a, b) => (a.downloaded_at < b.downloaded_at ? 1 : a.downloaded_at > b.downloaded_at ? -1 : 0));
  return sorted.map((f, i) => {
    const older = sorted[i + 1];
    const count = f.note_count ?? null;
    const delta = count !== null && older && older.note_count != null ? count - older.note_count : null;
    return {
      id: f.id,
      filename: f.filename,
      downloaded_at: f.downloaded_at,
      note_count: count,
      size: f.size,
      forced: f.job_id && f.job_id in forcedByJob ? forcedByJob[f.job_id] : null,
      drive_file_id: f.drive_file_id ?? null,
      delta,
    };
  });
}

/** Situação do cliente no mês (abas): uma só por cliente; "Para conferir" é à parte. */
export type MonthSituation = "com" | "sem" | "resp";

export interface MonthClient {
  clientId: string;
  name: string;
  code: string;
  cnpj: string;
  blocks: MonthBlock[];
  situation: MonthSituation;
  toCheck: boolean;
  /** arquivos com notas do cliente no mês (baixar tudo / abrir pasta) */
  files: DownloadRow[];
}

type Task = { client_id: string; document_type: DocumentType | null; status: TaskStatus; created_at: string };
type ClientInfo = { id: string; client_code: string; legal_name: string; trade_name: string | null; cnpj: string; active?: boolean };

const WAITING_STATE: Partial<Record<TaskStatus, BlockState>> = {
  pending: "queued",
  running: "queued",
  scheduled: "waiting",
  processed: "waiting",
  downloaded: "waiting",
  failed: "error",
};

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });

export function monthClients(
  files: DownloadRow[],
  empty: NoMovementRow[],
  tasks: Task[],
  clients: ClientInfo[],
  alerts: Record<string, NoteAlert> = {},
  /** trabalho -> veio de "Forçar reagendamento" (para o histórico de versões) */
  forcedByJob: Record<string, boolean> = {},
): MonthClient[] {
  const key = (clientId: string, doc: DocumentType) => `${clientId}|${doc}`;
  const latestFile = new Map<string, DownloadRow>();
  const allFiles = new Map<string, DownloadRow[]>();
  for (const f of files) {
    const k = key(f.client_id, f.document_type);
    const prev = latestFile.get(k);
    if (!prev || f.downloaded_at > prev.downloaded_at) latestFile.set(k, f);
    const group = allFiles.get(k);
    if (group) group.push(f);
    else allFiles.set(k, [f]);
  }
  const noMovement = new Map<string, NoMovementRow>();
  for (const n of empty) {
    const k = key(n.client_id, n.document_type);
    const prev = noMovement.get(k);
    if (!prev || n.checked_at > prev.checked_at) noMovement.set(k, n);
  }
  const latestTask = new Map<string, Task>();
  for (const t of tasks) {
    if (!t.document_type) continue;
    const k = key(t.client_id, t.document_type);
    const prev = latestTask.get(k);
    if (!prev || t.created_at > prev.created_at) latestTask.set(k, t);
  }

  const out: MonthClient[] = [];
  for (const c of clients) {
    const blocks: MonthBlock[] = [];
    for (const doc of BLOCK_ORDER) {
      const k = key(c.id, doc);
      const file = latestFile.get(k);
      const none = noMovement.get(k);
      const task = latestTask.get(k);
      // o "sem movimento" mais novo que o arquivo vale (pedido refeito sem notas)
      if (file && !(none && none.checked_at > file.downloaded_at)) {
        const blank = isEmptyZip(file) || file.note_count === 0;
        blocks.push({
          id: file.id,
          doc,
          state: blank ? "empty" : "file",
          count: blank ? 0 : (file.note_count ?? null),
          alert: alerts[file.id],
          file: blank ? undefined : file,
          versions: blank ? undefined : fileVersions(allFiles.get(k) ?? [file], forcedByJob),
        });
      } else if (none) {
        blocks.push({ id: none.id, doc, state: "empty", count: 0, alert: alerts[none.id] });
      } else if (task && c.active !== false) {
        const state = WAITING_STATE[task.status];
        if (state) blocks.push({ id: `task-${k}`, doc, state, count: null });
      }
    }
    if (blocks.length === 0) continue;
    const regular = blocks.filter((b) => !b.doc.endsWith("_CANCELADAS"));
    const pending = (b: MonthBlock) => b.state === "queued" || b.state === "waiting" || b.state === "error";
    const situation: MonthSituation = blocks.some((b) => b.state === "file")
      ? "com"
      : regular.some(pending)
        ? "resp"
        : "sem";
    out.push({
      clientId: c.id,
      name: c.trade_name || c.legal_name,
      code: c.client_code,
      cnpj: c.cnpj,
      blocks,
      situation,
      toCheck: blocks.some((b) => b.alert),
      files: blocks.flatMap((b) => (b.file ? [b.file] : [])),
    });
  }
  return out.sort((a, b) => collator.compare(a.name, b.name));
}

/** Só os blocos do chip escolhido (cliente sem nenhum some da lista). */
export function filterBlocks(rows: MonthClient[], type: TypeFilter): MonthClient[] {
  if (type === "all") return rows;
  return rows
    .map((r) => ({ ...r, blocks: r.blocks.filter((b) => blockKey(b.doc) === type) }))
    .filter((r) => r.blocks.length > 0);
}

const CHIP_KEYS: Exclude<TypeFilter, "all">[] = ["nfce", "emit", "receb", "nfse", "canc"];

/** Chip pela URL: ?type=nfse ou o formato antigo (?type=NFE_EMITIDAS). */
export function typeFilterFromDoc(value: unknown): TypeFilter {
  if (typeof value !== "string") return "all";
  if ((CHIP_KEYS as string[]).includes(value)) return value as TypeFilter;
  if (!(BLOCK_ORDER as string[]).includes(value)) return "all";
  return blockKey(value as DocumentType);
}
