// Quantidade de notas de cada download e o aviso de mês "estranho": nenhuma nota ou uma queda
// brusca em relação aos meses anteriores do mesmo cliente e tipo. Só avisa, não decide nada.

import { currentCompetence, parseCompetence, shiftCompetence } from "./competence.ts";
import type { DocumentType } from "./types.ts";

export type NoteCountRow = {
  id: string;
  client_id: string;
  document_type: DocumentType;
  competence: string;
  /** XMLs dentro do ZIP; null enquanto o robô ainda não contou */
  note_count?: number | null;
  downloaded_at: string;
};

export type NoteAlert = { kind: "zero" | "drop"; count: number; average: number; months: number; text: string };

/**
 * Compara com a média dos 3 meses anteriores (pelo menos 2 com notas contadas): avisa quando o mês
 * ficou abaixo da metade da média e com pelo menos 10 notas a menos (cliente pequeno não gera aviso).
 */
export const NOTE_ALERT = { months: 3, minHistory: 2, dropRatio: 0.5, dropMin: 10 };

const fmt = new Intl.NumberFormat("pt-BR");

/** Canceladas não geram aviso: ter poucas ou nenhuma nota cancelada é o normal. */
function isCanceled(r: { document_type: string }): boolean {
  return r.document_type.endsWith("_CANCELADAS");
}

export function notesLabel(count: number): string {
  return count === 1 ? "1 nota" : `${fmt.format(count)} notas`;
}

/** Fim do mês da competência no horário do Piauí (UTC-3), em ms. */
function monthEnd(competence: string): number | null {
  const next = shiftCompetence(competence, 1);
  return next ? Date.parse(`${next}-01T03:00:00Z`) : null;
}

type Month = { count: number; complete: boolean };

/**
 * Quantidade de cada mês por cliente e tipo. Se o mesmo mês foi baixado mais de uma vez, vale a
 * versão com mais notas. Mês baixado antes de terminar (ex.: o mês corrente) fica "incompleto":
 * não entra na média nem recebe aviso.
 */
function monthly(rows: NoteCountRow[]): Map<string, Month> {
  const months = new Map<string, Month>();
  for (const r of rows) {
    if (r.note_count == null || !parseCompetence(r.competence) || isCanceled(r)) continue;
    const end = monthEnd(r.competence);
    const complete = end != null && Date.parse(r.downloaded_at) >= end;
    const key = `${r.client_id}|${r.document_type}|${r.competence}`;
    const prev = months.get(key);
    if (!prev) months.set(key, { count: r.note_count, complete });
    else months.set(key, { count: Math.max(prev.count, r.note_count), complete: prev.complete || complete });
  }
  return months;
}

/** Aviso de cada download (pelo id); `history` são os downloads usados como comparação. */
export function noteAlerts(
  rows: NoteCountRow[],
  history: NoteCountRow[] = rows,
  now = new Date(),
): Record<string, NoteAlert> {
  const months = monthly(history.concat(rows));
  const current = currentCompetence(now);
  const alerts: Record<string, NoteAlert> = {};
  for (const r of rows) {
    if (r.note_count == null || r.competence >= current || isCanceled(r)) continue;
    const base = `${r.client_id}|${r.document_type}|`;
    const month = months.get(base + r.competence);
    if (!month?.complete) continue;
    const previous: number[] = [];
    for (let i = 1; i <= NOTE_ALERT.months; i += 1) {
      const m = months.get(base + shiftCompetence(r.competence, -i));
      if (m?.complete) previous.push(m.count);
    }
    if (previous.length < NOTE_ALERT.minHistory) continue;
    const mean = previous.reduce((a, b) => a + b, 0) / previous.length;
    // a versão com mais notas do mês: uma segunda versão vazia não dispara aviso
    const count = month.count;
    if (count >= mean * NOTE_ALERT.dropRatio || mean - count < NOTE_ALERT.dropMin) continue;
    const average = Math.round(mean);
    const media = `Nos ${previous.length} meses anteriores a média foi de ${notesLabel(average)}.`;
    alerts[r.id] = {
      kind: count === 0 ? "zero" : "drop",
      count,
      average,
      months: previous.length,
      text: count === 0 ? `Nenhuma nota neste mês. ${media}` : `Só ${notesLabel(count)} neste mês. ${media}`,
    };
  }
  return alerts;
}
