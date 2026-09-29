/**
 * Horário do Piauí em todo o painel.
 *
 * As páginas são montadas no servidor (Vercel, em UTC) e no navegador: sem fixar o
 * fuso, o servidor mostrava as horas 3h adiantadas (20:54 virava 23:54).
 */
export const APP_TIME_ZONE = "America/Fortaleza"; // UTC-3, sem horário de verão (mesmo fuso do Piauí)

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Ano, mês, dia e hora da data no horário do Piauí. */
export function zonedParts(date: Date): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** "2026-09-28" no horário do Piauí (para comparar dias). */
export function zonedDayKey(date: Date): string {
  const p = zonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
