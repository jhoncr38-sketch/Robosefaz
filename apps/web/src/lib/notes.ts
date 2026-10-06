// Tela Notas: consultas e regras puras sobre o índice de notas lido pelo robô.

import type { NoteRow } from "./types.ts";

/** Colunas da lista (sem o XML, que é grande). */
export const NOTE_LIST_SELECT =
  "id, client_id, document_type, competence, chave, modelo, serie, numero, emitida_em, valor, emit_doc, emit_nome, dest_doc, dest_nome, canceled, xml_at, clients(client_code, legal_name, trade_name, cnpj)";

/** A nota inteira, com o XML (se já entregue) e o ZIP de origem. */
export const NOTE_SELECT = "*, clients(client_code, legal_name, trade_name, cnpj), downloads(filename, drive_file_id)";

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** O cliente é quem emitiu a nota (senão, ele é o destinatário). */
export function issuedByClient(note: Pick<NoteRow, "emit_doc" | "clients">): boolean {
  const cnpj = digits(note.clients?.cnpj);
  return Boolean(cnpj) && digits(note.emit_doc) === cnpj;
}

/** A outra parte da nota, do ponto de vista do cliente: destinatário (nota emitida) ou emitente (recebida). */
export function counterparty(note: Pick<NoteRow, "emit_doc" | "emit_nome" | "dest_doc" | "dest_nome" | "clients">): {
  role: "Destinatário" | "Emitente";
  nome: string;
  doc: string;
} {
  if (issuedByClient(note)) return { role: "Destinatário", nome: note.dest_nome ?? "—", doc: note.dest_doc ?? "" };
  return { role: "Emitente", nome: note.emit_nome ?? "—", doc: note.emit_doc ?? "" };
}

/** "NF-e emitida", "NFC-e", "NF-e recebida" (+ cancelada). */
export function noteKind(note: Pick<NoteRow, "document_type" | "canceled">): { label: string; canceled: boolean } {
  const base = note.document_type.replace("_CANCELADAS", "");
  const label = base === "NFCE" ? "NFC-e" : base === "NFE_EMITIDAS" ? "NF-e emitida" : "NF-e recebida";
  return { label, canceled: note.canceled || note.document_type.endsWith("_CANCELADAS") };
}
