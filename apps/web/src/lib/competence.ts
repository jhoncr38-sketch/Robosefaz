// Competência: banco/API usam YYYY-MM; a interface exibe MM/YYYY.

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
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Lista das últimas N competências (mais recente primeiro), incluindo o mês atual. */
export function recentCompetences(count = 18, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  return out;
}
