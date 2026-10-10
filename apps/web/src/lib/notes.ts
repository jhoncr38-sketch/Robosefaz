// Tela Notas: consultas e regras puras sobre o índice de notas lido pelo robô.

import type { NoteRow } from "./types.ts";

/** Colunas da lista (sem o XML, que é grande). */
export const NOTE_LIST_SELECT =
  "id, client_id, document_type, competence, chave, modelo, serie, numero, emitida_em, valor, emit_doc, emit_nome, dest_doc, dest_nome, canceled, xml_at, clients(client_code, legal_name, trade_name, cnpj)";

/** A nota inteira, com o XML (se já entregue) e o ZIP de origem. */
export const NOTE_SELECT = "*, clients(client_code, legal_name, trade_name, cnpj), downloads(filename, drive_file_id)";

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** O cliente é quem emitiu a nota (senão, ele é o destinatário). Na NFS-e: o prestador. */
export function issuedByClient(note: Pick<NoteRow, "emit_doc" | "clients">): boolean {
  const cnpj = digits(note.clients?.cnpj);
  return Boolean(cnpj) && digits(note.emit_doc) === cnpj;
}

/** Nota de serviço (NFS-e Nacional, chave de 50 números). */
export function isNfse(note: Pick<NoteRow, "document_type">): boolean {
  return note.document_type === "NFSE_PRESTADAS" || note.document_type === "NFSE_TOMADAS";
}

/** A outra parte da nota, do ponto de vista do cliente: destinatário (nota emitida) ou emitente (recebida). */
export function counterparty(
  note: Pick<NoteRow, "emit_doc" | "emit_nome" | "dest_doc" | "dest_nome" | "clients"> & Partial<Pick<NoteRow, "document_type">>,
): {
  role: "Destinatário" | "Emitente" | "Tomador" | "Prestador";
  nome: string;
  doc: string;
} {
  const service = note.document_type ? isNfse({ document_type: note.document_type }) : false;
  if (issuedByClient(note)) return { role: service ? "Tomador" : "Destinatário", nome: note.dest_nome ?? "—", doc: note.dest_doc ?? "" };
  return { role: service ? "Prestador" : "Emitente", nome: note.emit_nome ?? "—", doc: note.emit_doc ?? "" };
}

/** "NF-e emitida", "NFC-e", "NF-e recebida", "NFS-e prestada", "NFS-e tomada" (+ cancelada). */
export function noteKind(note: Pick<NoteRow, "document_type" | "canceled">): { label: string; canceled: boolean } {
  if (note.document_type === "NFSE_PRESTADAS") return { label: "NFS-e prestada", canceled: note.canceled };
  if (note.document_type === "NFSE_TOMADAS") return { label: "NFS-e tomada", canceled: note.canceled };
  const base = note.document_type.replace("_CANCELADAS", "");
  const label = base === "NFCE" ? "NFC-e" : base === "NFE_EMITIDAS" ? "NF-e emitida" : "NF-e recebida";
  return { label, canceled: note.canceled || note.document_type.endsWith("_CANCELADAS") };
}
