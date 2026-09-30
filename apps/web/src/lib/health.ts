// Saúde da plataforma (aba "Saúde" em Escritórios, só o dono): semáforo e motivos de cada escritório.
// Só números de funcionamento (public.platform_health): nenhuma nota ou dado de cliente.

export interface HealthRobot {
  name: string;
  version: string | null;
  last_seen_at: string | null;
  /** sinal nos últimos 2 min (o robô manda a cada 30 s) */
  online: boolean;
  outdated: boolean;
}

export interface HealthLimits {
  offline_hours: number | string;
  outdated_days: number | string;
  failures_day: number | string;
  min_success: number | string;
  stuck_hours: number | string;
}

export interface PlatformHealthRow {
  org_id: string;
  name: string;
  status: "active" | "suspended";
  clients: number;
  max_clients: number | null;
  latest_version: string | null;
  robots: HealthRobot[];
  hours_since_signal: number | string | null;
  completed_7d: number;
  failed_7d: number;
  failed_today: number;
  stuck: number;
  waiting_person: number;
  no_certificate: number;
  failures_by_code: Record<string, number>;
  certs_expiring: number;
  certs_expired: number;
  last_activity: string | null;
  limits: HealthLimits;
}

export type HealthLevel = "problem" | "attention" | "ok" | "idle";

export interface HealthAssessment {
  level: HealthLevel;
  reasons: string[];
  /** os primeiros `problems` motivos são problemas (o resto, atenção) */
  problems: number;
  successRate: number | null;
}

export const HEALTH_LABEL: Record<HealthLevel, string> = {
  problem: "Problema",
  attention: "Atenção",
  ok: "Tudo certo",
  idle: "Sem robô",
};

const ORDER: HealthLevel[] = ["problem", "attention", "ok", "idle"];

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

/** 0,4 → "24 min"; 2,7 → "2,7 h"; 50 → "2 dias" */
export function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
  return `${Math.floor(hours / 24)} dias`;
}

export function successRate(row: Pick<PlatformHealthRow, "completed_7d" | "failed_7d">): number | null {
  const total = row.completed_7d + row.failed_7d;
  return total > 0 ? row.completed_7d / total : null;
}

export function assessOrg(row: PlatformHealthRow): HealthAssessment {
  const rate = successRate(row);
  if (row.status !== "active") return { level: "idle", reasons: ["Escritório suspenso"], problems: 0, successRate: rate };
  if (row.robots.length === 0) {
    return { level: "idle", reasons: ["Nenhum computador ativado"], problems: 0, successRate: rate };
  }

  const limits = {
    offline: num(row.limits.offline_hours) ?? 2,
    failures: num(row.limits.failures_day) ?? 5,
    minSuccess: num(row.limits.min_success) ?? 0.8,
    stuckHours: num(row.limits.stuck_hours) ?? 6,
  };
  const problems: string[] = [];
  const attention: string[] = [];

  if (row.failed_today >= limits.failures) problems.push(`${row.failed_today} falha(s) hoje`);
  const total = row.completed_7d + row.failed_7d;
  if (rate !== null && total >= 10 && rate < limits.minSuccess) {
    problems.push(`só ${Math.round(rate * 100)}% de sucesso em 7 dias`);
  }
  if (row.stuck > 0) problems.push(`${row.stuck} aguardando a SEFAZ há mais de ${limits.stuckHours} h`);

  const hours = num(row.hours_since_signal);
  if (hours === null) attention.push("nenhum robô deu sinal ainda");
  else if (hours >= limits.offline) attention.push(`nenhum robô ligado há ${hoursLabel(hours)}`);
  const outdated = row.robots.filter((r) => r.outdated);
  if (outdated.length > 0) {
    attention.push(
      `${outdated.map((r) => `${r.name} (${r.version ?? "?"})`).join(", ")} desatualizado${outdated.length > 1 ? "s" : ""}` +
        (row.latest_version ? `; a mais nova é ${row.latest_version}` : ""),
    );
  }
  if (row.no_certificate > 0) attention.push(`${row.no_certificate} trabalho(s) sem certificado`);
  if (row.waiting_person > 0) attention.push(`${row.waiting_person} aguardando alguém no robô`);
  if (row.certs_expired > 0) attention.push(`${row.certs_expired} certificado(s) vencido(s)`);
  if (row.certs_expiring > 0) attention.push(`${row.certs_expiring} certificado(s) vencendo em 30 dias`);

  const level: HealthLevel = problems.length ? "problem" : attention.length ? "attention" : "ok";
  return { level, reasons: [...problems, ...attention], problems: problems.length, successRate: rate };
}

/** Problemas primeiro; depois atenção, tudo certo e sem robô (desempate pelo nome). */
export function sortByHealth<T extends PlatformHealthRow>(rows: T[]): (T & { health: HealthAssessment })[] {
  return rows
    .map((row) => ({ ...row, health: assessOrg(row) }))
    .sort((a, b) => ORDER.indexOf(a.health.level) - ORDER.indexOf(b.health.level) || a.name.localeCompare(b.name, "pt-BR"));
}
