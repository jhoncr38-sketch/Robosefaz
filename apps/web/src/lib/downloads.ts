// Regras da tela Downloads: ZIP vazio e notas no Google Drive.
import type { createClient } from "@/lib/supabase/server";

import { isoDaysFromNow } from "./format.ts";

/** ZIP vazio tem 22 bytes (só o fim do índice): o SIAT processou, mas não havia nota no período. */
export const EMPTY_ZIP_BYTES = 22;

export function isEmptyZip(d: { filename: string; size: number }): boolean {
  return d.filename.toLowerCase().endsWith(".zip") && d.size <= EMPTY_ZIP_BYTES;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{15,100}$/;

/**
 * Baixa a nota direto do Google Drive (o robô grava o código do arquivo depois que
 * ele sobe). Funciona em qualquer computador, para quem tem acesso à pasta
 * "JR Sistema - Notas". null se ainda não há código (nota subindo) ou se é inválido.
 */
export function driveDownloadUrl(driveFileId: string | null | undefined): string | null {
  if (!driveFileId || !DRIVE_ID.test(driveFileId)) return null;
  return `https://drive.google.com/uc?export=download&id=${driveFileId}`;
}

/** Abre a pasta no Google Drive (lá, "Fazer download" baixa a pasta inteira como ZIP). */
export function driveFolderUrl(folderId: string | null | undefined): string | null {
  if (!folderId || !DRIVE_ID.test(folderId)) return null;
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export interface BulkTarget {
  /** "month": todas as notas do mês; "client": as notas de um cliente no mês */
  kind: "month" | "client";
  folderUrl: string | null;
  files: number;
  clients: number;
}

/** "Baixar todas": precisa da competência; com cliente, só a pasta dele no mês. */
export function bulkTarget(
  rows: { competence: string; client_id: string; filename: string; size: number; drive_client_folder_id?: string | null; drive_month_folder_id?: string | null }[],
  competence: string | undefined,
  clientId: string | undefined,
): BulkTarget | null {
  if (!competence) return null;
  const scope = rows.filter((r) => r.competence === competence && (!clientId || r.client_id === clientId) && !isEmptyZip(r));
  const folderId = clientId
    ? scope.find((r) => r.drive_client_folder_id)?.drive_client_folder_id
    : scope.find((r) => r.drive_month_folder_id)?.drive_month_folder_id;
  return {
    kind: clientId ? "client" : "month",
    folderUrl: driveFolderUrl(folderId),
    files: scope.length,
    clients: new Set(scope.map((r) => r.client_id)).size,
  };
}

/** Algum robô do escritório salva as notas no Google Drive (informado no sinal de vida, desde a 1.2.6). */
export function usesGoogleDrive(heartbeats: { meta: Record<string, unknown> | null }[]): boolean {
  return heartbeats.some((w) => w.meta?.notes_folder === "google_drive");
}

/** Consulta os robôs que deram sinal nos últimos 30 dias. */
export async function notesInGoogleDrive(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  const { data } = await supabase
    .from("worker_heartbeats")
    .select("meta")
    .gte("last_seen_at", isoDaysFromNow(-30))
    .limit(200);
  return usesGoogleDrive((data ?? []) as { meta: Record<string, unknown> | null }[]);
}
