// Aviso da tela NFS-e Nacional: quanto a prefeitura demora para repassar as notas de serviço ao ambiente
// nacional. Os números vêm de nfse_adn_delay (notas do escritório que chegaram nos últimos 30 dias).

/** Uma linha de nfse_adn_delay: uma cidade emissora. */
export interface AdnDelayRow {
  c_loc_emi: string;
  notas: number | string;
  /** tempo típico: metade das notas chegou em até isso (segundos) */
  mediana_s: number;
  /** quantas levaram mais de um dia */
  acima_1d: number | string;
  pior_s: number;
  ultima_chegada: string | null;
}

export interface AdnDelayNotice {
  codigo: string;
  cidade: string;
  notas: number;
  /** de cada 100 notas, quantas levaram mais de um dia */
  atrasadas: number;
  tipico: string;
  pior: string;
}

const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "38 segundos", "21 minutos", "30 horas", "7 dias" */
export function formatDelay(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return unit(Math.max(1, s), "segundo", "segundos");
  if (s < 90 * 60) return unit(Math.round(s / 60), "minuto", "minutos");
  if (s < 48 * 3600) return unit(Math.round(s / 3600), "hora", "horas");
  return unit(Math.round(s / 86400), "dia", "dias");
}

/** poucas notas não dizem nada sobre a cidade */
const MIN_NOTES = 5;
const HOUR = 3600;
/** sem chegada registrada há mais do que isso, os números estão velhos: melhor não mostrar */
const FRESH_DAYS = 10;

/** A hora de chegada só é gravada pelos robôs a partir da versão que traz essa função. Se a última chegada
 *  registrada da cidade já é antiga, o aviso estaria falando do passado como se fosse de agora. */
function fresh(r: AdnDelayRow, now: Date): boolean {
  const last = r.ultima_chegada ? Date.parse(r.ultima_chegada) : NaN;
  return !Number.isNaN(last) && now.getTime() - last <= FRESH_DAYS * 24 * HOUR * 1000;
}

/** Só as cidades com atraso que importa: ao menos 1 em cada 10 notas levou mais de um dia, ou o tempo típico
 *  passa de 3 horas. Quando tudo chega em minutos, não há o que avisar. */
export function delayNotices(rows: AdnDelayRow[], cityName: (code: string) => string | undefined, now: Date = new Date()): AdnDelayNotice[] {
  return rows
    .filter((r) => fresh(r, now))
    .map((r) => {
      const notas = Number(r.notas) || 0;
      const late = Number(r.acima_1d) || 0;
      return { r, notas, share: notas ? late / notas : 0 };
    })
    .filter(({ r, notas, share }) => notas >= MIN_NOTES && (share >= 0.1 || r.mediana_s >= 3 * HOUR))
    .sort((a, b) => b.notas - a.notas)
    .map(({ r, notas, share }) => ({
      codigo: r.c_loc_emi,
      cidade: cityName(r.c_loc_emi) ?? `município ${r.c_loc_emi}`,
      notas,
      atrasadas: Math.round(share * 100),
      tipico: formatDelay(r.mediana_s),
      pior: formatDelay(r.pior_s),
    }));
}

// ---- o mês anterior já está aqui? ---------------------------------------------------------------------
// Para fechar o mês (Simples, por exemplo) importa saber se as notas do mês anterior que a prefeitura
// repassou com atraso já chegaram e se as buscas foram feitas depois disso. É um indício, não uma prova:
// uma nota que a prefeitura ainda não repassou não aparece em lugar nenhum.

/** Uma NFS-e do mês, gerada pelo sistema da prefeitura, com a hora em que chegou ao ambiente nacional. */
export interface MonthArrivalRow {
  c_loc_emi: string | null;
  adn_recebida_em: string | null;
}

export interface MonthClosing {
  /** notas do mês conhecidas, desta cidade */
  notas: number;
  /** quantas chegaram depois que o mês acabou */
  atrasadas: number;
  /** quando chegou a última dessas (ISO); null se nenhuma atrasou */
  ultimaChegada: string | null;
  /** empresas cuja última busca é anterior a essa chegada (ou ao fim do mês): podem estar sem as atrasadas */
  buscasAntigas: number;
  /** a busca mais antiga entre as empresas (ISO) */
  buscaMaisAntiga: string | null;
  situacao: "provavel" | "buscar";
}

const BRASILIA = "America/Sao_Paulo";

/** Mês anterior ao de hoje, no horário de Brasília: "2026-09". */
export function previousMonth(today: Date): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: BRASILIA, year: "numeric", month: "2-digit" }).format(today).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Início do mês e início do mês seguinte, no horário de Brasília (ISO com -03:00). */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: `${month}-01T00:00:00-03:00`, end: `${next}-01T00:00:00-03:00` };
}

/** "setembro" */
export function monthName(month: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: BRASILIA, month: "long" }).format(new Date(`${month}-15T12:00:00-03:00`));
}

/** "07/10" */
export function shortDay(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: BRASILIA, day: "2-digit", month: "2-digit" }).format(new Date(iso));
}

/** Só dá para falar do mês quando quase todas as NFS-e dele têm a hora de chegada gravada. Com robôs que ainda
 *  não gravam essa hora, uma parte das notas ficaria de fora da conta e a frase diria "nenhuma atrasou" sem saber. */
export function monthCovered(total: number, withArrival: number): boolean {
  return total > 0 && withArrival / total >= 0.9;
}

/** Situação do mês em cada cidade emissora. `searches`: data da última busca de cada empresa já buscada. */
export function monthClosing(rows: MonthArrivalRow[], month: string, searches: (string | null | undefined)[]): Record<string, MonthClosing> {
  const end = Date.parse(monthBounds(month).end);
  const done = searches
    .filter((v): v is string => Boolean(v))
    .map((v) => Date.parse(v))
    .filter((t) => !Number.isNaN(t));
  const oldest = done.length ? Math.min(...done) : null;
  const byCity = new Map<string, number[]>();
  for (const r of rows) {
    const at = r.adn_recebida_em ? Date.parse(r.adn_recebida_em) : NaN;
    if (!r.c_loc_emi || Number.isNaN(at)) continue;
    byCity.set(r.c_loc_emi, [...(byCity.get(r.c_loc_emi) ?? []), at]);
  }
  const out: Record<string, MonthClosing> = {};
  for (const [city, arrivals] of byCity) {
    const late = arrivals.filter((t) => t >= end);
    const lastLate = late.length ? Math.max(...late) : null;
    // quem buscou antes da última chegada atrasada (ou antes de o mês acabar) pode estar sem essas notas
    const reference = lastLate ?? end;
    const stale = done.filter((t) => t < reference).length;
    out[city] = {
      notas: arrivals.length,
      atrasadas: late.length,
      ultimaChegada: lastLate === null ? null : new Date(lastLate).toISOString(),
      buscasAntigas: stale,
      buscaMaisAntiga: oldest === null ? null : new Date(oldest).toISOString(),
      situacao: stale > 0 || oldest === null ? "buscar" : "provavel",
    };
  }
  return out;
}
