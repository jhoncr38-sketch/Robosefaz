// Competência: banco/API usam YYYY-MM; a interface exibe MM/YYYY.

import { zonedParts } from "./timezone.ts";

const KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DISPLAY_RE = /^(0[1-9]|1[0-2])\/(\d{4})$/;

export function parseCompetence(value: string): { year: number; month: number } | null {
  const v = value.trim();
  let m = KEY_RE.exec(v);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  m = DISPLAY_RE.exec(v);
  if (m) return { year: Number(m[2]), month: Number(m[1]) };
  return null;
}

export function toCompetenceKey(value: string): string | null {
  const p = parseCompetence(value);
  return p ? `${p.year}-${String(p.month).padStart(2, "0")}` : null;
}

export function formatCompetence(value: string | null | undefined): string {
  if (!value) return "";
  const p = parseCompetence(value);
  return p ? `${String(p.month).padStart(2, "0")}/${p.year}` : value;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Primeiro e último dia do mês, no formato DD/MM/YYYY. */
export function competenceBounds(value: string): { start: string; end: string } | null {
  const p = parseCompetence(value);
  if (!p) return null;
  const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return { start: `01/${pad(p.month)}/${p.year}`, end: `${pad(last)}/${pad(p.month)}/${p.year}` };
}

/** Competência anterior ao mês atual (a mais comum para exportação). */
export function previousCompetence(now = new Date()): string {
  return shiftCompetence(currentCompetence(now), -1) as string;
}

/** Lista das últimas N competências (mais recente primeiro), incluindo o mês atual. */
export function recentCompetences(count = 18, now = new Date()): string[] {
  const current = currentCompetence(now);
  return Array.from({ length: count }, (_, i) => shiftCompetence(current, -i) as string);
}

/** Competência deslocada em N meses (YYYY-MM); null se a entrada for inválida. */
export function shiftCompetence(value: string, delta: number): string | null {
  const p = parseCompetence(value);
  if (!p) return null;
  const d = new Date(p.year, p.month - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Competência do mês corrente (limite para agendar). */
export function currentCompetence(now = new Date()): string {
  // mês no horário do Piauí (o servidor roda em UTC: dia 30 às 22h já seria o mês seguinte)
  const p = zonedParts(now);
  return `${p.year}-${pad(p.month)}`;
}
