// Tela Resultados › Faturamento: linhas de faturamento_mensal (somas do índice de notas por mês de competência).

/** Uma linha de faturamento_mensal: um mês de uma empresa. */
export interface MonthTotals {
  competence: string;
  saidas: number | string;
  entradas: number | string;
  prestados: number | string;
  tomados: number | string;
  notas: number;
  canceladas: number;
}

export interface MonthView {
  competence: string;
  /** saídas + serviços prestados */
  faturamento: number;
  saidas: number;
  entradas: number;
  prestados: number;
  tomados: number;
  notas: number;
  canceladas: number;
}

const num = (v: number | string) => Number(v) || 0;

/** Os totais do mês como a tela mostra; faturamento = saídas + serviços prestados. */
export function monthView(r: MonthTotals): MonthView {
  const saidas = num(r.saidas);
  const prestados = num(r.prestados);
  return {
    competence: r.competence,
    faturamento: Math.round((saidas + prestados) * 100) / 100,
    saidas,
    entradas: num(r.entradas),
    prestados,
    tomados: num(r.tomados),
    notas: Number(r.notas) || 0,
    canceladas: Number(r.canceladas) || 0,
  };
}

/** "2026-09" -> "09/2026" */
export function monthLabel(competence: string): string {
  return /^\d{4}-\d{2}$/.test(competence) ? `${competence.slice(5)}/${competence.slice(0, 4)}` : competence;
}

/** O mês a abrir: o pedido, se a empresa tem notas nele; senão o mais recente. */
export function pickMonth(rows: MonthTotals[], wanted: string | undefined): string {
  if (wanted && rows.some((r) => r.competence === wanted)) return wanted;
  return rows[0]?.competence ?? "";
}

export function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
