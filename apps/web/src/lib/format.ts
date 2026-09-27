import { differenceInSeconds, format, formatDistanceToNowStrict } from "date-fns";
import { ptBR } from "date-fns/locale";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return format(new Date(value), "dd/MM/yyyy HH:mm", { locale: ptBR });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return format(d, "dd/MM/yyyy", { locale: ptBR });
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  return formatDistanceToNowStrict(new Date(value), { locale: ptBR, addSuffix: true });
}

export function formatDuration(start: string | null | undefined, end?: string | null): string {
  if (!start) return "—";
  const seconds = Math.max(0, differenceInSeconds(end ? new Date(end) : new Date(), new Date(start)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}

/** ISO de agora ± N dias (para filtros de consulta no servidor). */
export function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** "agora", "5 min", "2h", "ontem", "12/09" — coluna "Quando" das listas compactas. */
export function formatShortAgo(value: string | null | undefined, now = new Date()): string {
  if (!value) return "—";
  const d = new Date(value);
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (hours < 24 && d.getDate() === now.getDate()) return `${hours}h`;
  if (d >= yesterday) return "ontem";
  return format(d, "dd/MM", { locale: ptBR });
}

/** 125 → "2:05" (cronômetros e contagens regressivas). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
