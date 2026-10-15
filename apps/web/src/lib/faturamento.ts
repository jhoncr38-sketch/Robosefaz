// Tela Resultados › Faturamento: linhas de faturamento_resumo (somas do índice de notas por empresa e mês de
// competência, mantidas por gatilho no banco) viram a visão de uma empresa ou a de todas as empresas num mês.

/** valor de `empresa` na URL para a visão do escritório inteiro */
export const ALL_COMPANIES = "todas";

/** Os totais de um mês de uma empresa, como o banco devolve (numéricos podem vir como texto). */
export interface MonthTotals {
  competence: string;
  saidas: number | string;
  entradas: number | string;
  prestados: number | string;
  tomados: number | string;
  notas: number;
  canceladas: number;
}

/** Uma linha de faturamento_resumo: uma empresa e um mês. */
export interface ResumoRow extends MonthTotals {
  client_id: string;
}

export interface MonthView {
  competence: string;
  /** total de saídas: saídas de mercadorias + serviços prestados (o "Faturamento do mês") */
  faturamento: number;
  /** total de entradas: entradas de mercadorias + serviços tomados */
  totalEntradas: number;
  saidas: number;
  entradas: number;
  prestados: number;
  tomados: number;
  notas: number;
  canceladas: number;
}

export interface FaturamentoClient {
  id: string;
  client_code: string;
  name: string;
  cnpj: string;
}

/** Uma empresa na tabela de todas; `view` nulo = sem notas baixadas naquele mês. */
export interface CompanyTotals extends FaturamentoClient {
  view: MonthView | null;
}

export type SortKey = "name" | "saidas" | "prestados" | "faturamento" | "entradas" | "tomados" | "totalEntradas" | "notas";
export type SortDir = "asc" | "desc";

export interface OfficeMonth {
  competence: string;
  /** com notas primeiro, na ordem pedida; sem notas por último, por nome */
  companies: CompanyTotals[];
  /** soma do escritório no mês (só das empresas com notas) */
  total: MonthView;
  withNotes: number;
  withoutNotes: number;
}

const num = (v: number | string) => Number(v) || 0;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Os totais do mês como a tela mostra; faturamento = saídas + serviços prestados. */
export function monthView(r: MonthTotals): MonthView {
  const saidas = num(r.saidas);
  const prestados = num(r.prestados);
  const entradas = num(r.entradas);
  const tomados = num(r.tomados);
  return {
    competence: r.competence,
    faturamento: round2(saidas + prestados),
    totalEntradas: round2(entradas + tomados),
    saidas,
    entradas,
    prestados,
    tomados,
    notas: Number(r.notas) || 0,
    canceladas: Number(r.canceladas) || 0,
  };
}

/** "2026-09" -> "09/2026" */
export function monthLabel(competence: string): string {
  return /^\d{4}-\d{2}$/.test(competence) ? `${competence.slice(5)}/${competence.slice(0, 4)}` : competence;
}

/** Meses presentes nas linhas, sem repetir, do mais recente ao mais antigo. */
export function monthsOf(rows: { competence: string }[]): string[] {
  return [...new Set(rows.map((r) => r.competence).filter((c) => /^\d{4}-\d{2}$/.test(c)))].sort((a, b) => b.localeCompare(a));
}

/** O mês a abrir: o pedido, se está na lista; senão o mais recente. */
export function pickCompetence(months: string[], wanted: string | undefined): string {
  if (wanted && months.includes(wanted)) return wanted;
  return months[0] ?? "";
}

/** O mês a abrir para uma empresa: o pedido, se ela tem notas nele; senão o mais recente. */
export function pickMonth(rows: MonthTotals[], wanted: string | undefined): string {
  return pickCompetence(monthsOf(rows), wanted);
}

export function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "1234.5" -> "1.234,50" (a tabela de todas diz "valores em R$" uma vez só) */
export function formatAmount(value: number): string {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const byName = (a: FaturamentoClient, b: FaturamentoClient) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

/** Todas as empresas num mês: uma linha por empresa (com ou sem notas) e a soma do escritório. */
export function officeMonth(
  clients: FaturamentoClient[],
  rows: ResumoRow[],
  competence: string,
  sort: { key: SortKey; dir: SortDir } = { key: "faturamento", dir: "desc" },
): OfficeMonth {
  const byClient = new Map(rows.filter((r) => r.competence === competence).map((r) => [r.client_id, monthView(r)]));
  const companies: CompanyTotals[] = clients.map((c) => ({
    ...c,
    view: byClient.get(c.id) ?? null,
  }));
  const withNotes = companies.filter((c) => c.view !== null);
  const withoutNotes = companies.filter((c) => c.view === null).sort(byName);

  const dir = sort.dir === "asc" ? 1 : -1;
  withNotes.sort((a, b) => {
    if (sort.key === "name") return byName(a, b) * dir;
    const diff = (a.view as MonthView)[sort.key] - (b.view as MonthView)[sort.key];
    return diff !== 0 ? diff * dir : byName(a, b);
  });

  const sum = (key: Exclude<SortKey, "name">) => round2(withNotes.reduce((acc, c) => acc + (c.view as MonthView)[key], 0));
  const total: MonthView = {
    competence,
    faturamento: sum("faturamento"),
    totalEntradas: sum("totalEntradas"),
    saidas: sum("saidas"),
    entradas: sum("entradas"),
    prestados: sum("prestados"),
    tomados: sum("tomados"),
    notas: sum("notas"),
    canceladas: round2(withNotes.reduce((acc, c) => acc + (c.view as MonthView).canceladas, 0)),
  };
  return {
    competence,
    companies: [...withNotes, ...withoutNotes],
    total,
    withNotes: withNotes.length,
    withoutNotes: withoutNotes.length,
  };
}

/** Filtro da tabela de todas: tudo, só o lado das saídas ou só o lado das entradas. */
export type OfficeSide = "tudo" | "saidas" | "entradas";

export interface OfficeColumn {
  key: Exclude<SortKey, "name">;
  label: string;
  /** parcela (pode ser escondida com "Só os totais") */
  part?: boolean;
  /** total do lado (sempre visível) */
  total?: boolean;
  /** lado da coluna; a contagem de notas não tem lado e só aparece em "tudo" */
  side?: Exclude<OfficeSide, "tudo">;
}

export const OFFICE_COLUMNS: OfficeColumn[] = [
  { key: "saidas", label: "Saídas", part: true, side: "saidas" },
  { key: "prestados", label: "Serv. prestados", part: true, side: "saidas" },
  { key: "faturamento", label: "Total de saídas", total: true, side: "saidas" },
  { key: "entradas", label: "Entradas", part: true, side: "entradas" },
  { key: "tomados", label: "Serv. tomados", part: true, side: "entradas" },
  { key: "totalEntradas", label: "Total de entradas", total: true, side: "entradas" },
  { key: "notas", label: "Notas" },
];

/** As colunas visíveis para o filtro de lado e o botão "Só os totais". */
export function officeColumns(side: OfficeSide, showParts: boolean): OfficeColumn[] {
  return OFFICE_COLUMNS.filter((c) => (side === "tudo" || c.side === side) && (showParts || !c.part));
}

/** Ao trocar o lado, a ordenação segue para o total daquele lado se a coluna atual sumiu. */
export function sortForSide(side: OfficeSide, current: { key: SortKey; dir: SortDir }): { key: SortKey; dir: SortDir } {
  if (current.key === "name" || officeColumns(side, true).some((c) => c.key === current.key)) return current;
  return { key: side === "entradas" ? "totalEntradas" : "faturamento", dir: "desc" };
}
