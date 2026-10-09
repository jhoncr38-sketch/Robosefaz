// Tela "Operação do dia": período, explicação automática dos atrasos e faixa de cada computador.
// Os dados vêm da função operation_report do banco (só leitura).

import type { JobOperation, JobStatus } from "./types.ts";

export type Period = "manha" | "tarde" | "noite" | "dia";

export const PERIODS: { key: Period; label: string; from: number; to: number }[] = [
  { key: "manha", label: "Manhã", from: 6, to: 12 },
  { key: "tarde", label: "Tarde", from: 12, to: 18 },
  { key: "noite", label: "Noite", from: 18, to: 24 },
  { key: "dia", label: "Dia todo", from: 0, to: 24 },
];

/** O escritório trabalha no horário do Piauí (UTC-3, sem horário de verão). */
const OFFSET = "-03:00";

export function todayLocal(now = new Date()): string {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return local.toISOString().slice(0, 10);
}

export function parseDay(value: unknown, now = new Date()): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : todayLocal(now);
}

export function parsePeriod(value: unknown): Period {
  return PERIODS.some((p) => p.key === value) ? (value as Period) : "dia";
}

/** Início e fim do período no dia (horário do Piauí), em ISO. */
export function periodBounds(day: string, period: Period): { from: string; to: string } {
  const p = PERIODS.find((x) => x.key === period) ?? PERIODS[3];
  const start = new Date(`${day}T00:00:00${OFFSET}`);
  return {
    from: new Date(start.getTime() + p.from * 3_600_000).toISOString(),
    to: new Date(start.getTime() + p.to * 3_600_000).toISOString(),
  };
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// --- dados ------------------------------------------------------------------

export interface OpLog {
  at: string;
  level: "INFO" | "WARNING" | "ERROR" | "DEBUG";
  step: string | null;
  msg: string;
}

export interface OpJob {
  id: string;
  client_code: string;
  client_name: string;
  operations: JobOperation[];
  competence: string;
  force: boolean;
  note_key: boolean;
  status: JobStatus;
  attempts: number;
  check_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  message: string;
  files: number;
  notes: number;
  logs: OpLog[];
}

export interface OpSession {
  org_id: string;
  org_name: string | null;
  own: boolean;
  worker_id: string;
  host: string;
  version: string | null;
  status: string;
  started_at: string;
  last_seen_at: string;
}

export interface OpOffice {
  id: string;
  name: string;
  status: string;
  created_at: string;
  own: boolean;
  clients: number;
  certificates: number;
  certificates_expired: number;
  users: number;
  last_access: string | null;
  robots: number;
  robots_online: number;
  jobs: number;
  jobs_completed: number;
  jobs_failed: number;
  files: number;
  notes: number;
}

export interface OpEvent {
  at: string;
  kind: "device_on" | "device_off" | "org" | "client" | "certificate" | "user";
  org_name: string | null;
  own: boolean;
  text: string;
}

export interface OperationReport {
  owner: boolean;
  org_id: string;
  org_name: string;
  now: string;
  jobs: OpJob[];
  sessions: OpSession[];
  offices: OpOffice[] | null;
  events: OpEvent[];
}

// --- explicação do atraso -------------------------------------------------------

const MIN = 60_000;
/** acima disso o trabalho é marcado como demorado */
export const SLOW_MINUTES = 15;

const ms = (iso: string) => new Date(iso).getTime();
const hhmm = (t: number) =>
  new Date(t - 3 * 3_600_000).toISOString().slice(11, 16); // horário do Piauí

/** Robô que agendou (dos registros "Job iniciado ... por PC-1234"). */
export function jobRobots(job: OpJob): string[] {
  const hosts = new Set<string>();
  for (const l of job.logs) {
    const m = /^Job iniciado .* por ([A-Za-z0-9_.-]+?)(?:-\d+)?\. /.exec(l.msg);
    if (m) hosts.add(m[1]);
  }
  return [...hosts];
}

export function jobMinutes(job: OpJob, now: string): number | null {
  if (!job.started_at) return null;
  return Math.round((ms(job.finished_at ?? now) - ms(job.started_at)) / MIN);
}

/** Algum robô do escritório estava ligado entre `a` e `b`? */
function covered(sessions: OpSession[], a: number, b: number): boolean {
  return sessions.some((s) => s.own && ms(s.started_at) < b && ms(s.last_seen_at) > a);
}

/**
 * Por que o trabalho demorou (ou falhou), em frases curtas, a partir dos registros do robô.
 * Só explica quando há o que explicar: trabalho demorado, com erro ou com tentativas.
 */
export function explainJob(job: OpJob, sessions: OpSession[], now: string): string[] {
  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const minutes = jobMinutes(job, now) ?? 0;
  const logs = job.logs;

  for (const l of logs) {
    const m = l.msg;
    let r: RegExpExecArray | null;
    if ((r = /não está instalado neste computador \(([^)]+)\)/.exec(m)) || (r = /Certificado não instalado em ([^;]+);/.exec(m))) {
      add(`Certificado não instalado em ${r[1]}: repassado a outro computador`);
    } else if (/aguardando sua intervenção: Aguardando seleção do certificado/.test(m)) {
      add("Esperou alguém escolher o certificado no Windows");
    } else if ((r = /Robô que executava foi desligado.*robô anterior: ([A-Za-z0-9_.-]+?)(?:-\d+)?\)/.exec(m))) {
      add(`O robô ${r[1]} parou no meio do trabalho (desligado ou em suspensão)`);
    } else if (/Connection closed while reading from the driver|Target page, context or browser has been closed/.test(m)) {
      add("O navegador do robô foi fechado à força (computador desligado ou em suspensão)");
    } else if (/503|TEMPORARIAMENTE INDISPON|temporariamente indispon/i.test(m)) {
      add("SIAT fora do ar (erro 503)");
    } else if (l.level === "ERROR" && /\[TIMEOUT\]/.test(m)) {
      add("Páginas do SIAT demoraram a responder");
    } else if (l.level === "ERROR" && /\[SELECTOR_NOT_FOUND\]/.test(m)) {
      add("Uma tela do SIAT não mostrou o que o robô esperava");
    } else if (l.level === "ERROR" && /\[LOGIN_FAILED\]/.test(m)) {
      add("O login no SIAT não se completou");
    } else if (/\[TAXPAYER_MISMATCH\]|\[SECURITY_CLIENT_MISMATCH\]/.test(m)) {
      add("O SIAT não abriu o contribuinte do cliente (tipo de usuário ou certificado)");
    } else if (/Conferência rápida em pausa automática/.test(m)) {
      add("Conferência rápida em pausa (SEFAZ lenta naquele momento)");
    }
  }

  const retries = logs.filter((l) => l.step === "retry" && /retentativa/.test(l.msg)).length;
  if (retries > 0) add(`${retries} nova(s) tentativa(s) depois de erro`);

  // fechou o navegador e esperou a consulta normal
  const waited = logs.find((l) => /^Navegador fechado/.test(l.msg));
  if (waited && job.check_count > 0) {
    const m = /consultará em (\d+) min/.exec(waited.msg);
    add(
      m
        ? `Esperou a consulta de ${m[1]} min para baixar (${job.check_count} consulta(s))`
        : `Parte das notas ficou para a consulta normal (${job.check_count} consulta(s))`,
    );
  }
  if (job.check_count >= 3) add(`A SEFAZ demorou para processar (${job.check_count} consultas)`);

  // buracos longos entre um registro e outro, sem nenhum robô do escritório ligado
  for (let i = 1; i < logs.length; i++) {
    const a = ms(logs[i - 1].at);
    const b = ms(logs[i].at);
    if (b - a > 35 * MIN && !covered(sessions, a + 2 * MIN, b - 2 * MIN)) {
      add(`Nenhum robô do escritório ligado de ${hhmm(a)} a ${hhmm(b)}`);
    }
  }
  // ainda esperando, sem robô ligado agora
  if (!job.finished_at && logs.length > 0) {
    const last = ms(logs[logs.length - 1].at);
    const n = ms(now);
    if (n - last > 35 * MIN && !covered(sessions, last + 2 * MIN, n)) {
      add(`Nenhum robô do escritório ligado desde ${hhmm(last)}`);
    }
  }

  const relevant = minutes >= SLOW_MINUTES || job.status === "failed" || retries > 0 || reasons.length > 0;
  return relevant ? reasons : [];
}

// --- faixa dos computadores ---------------------------------------------------------

export type SessionEnd = "running" | "stopped" | "abrupt";

/** Como a sessão terminou: ainda ligada, parada normalmente ou de repente (sem se despedir). */
export function sessionEnd(s: OpSession, now: string): SessionEnd {
  if (s.status === "stopped") return "stopped";
  return ms(now) - ms(s.last_seen_at) > 3 * MIN ? "abrupt" : "running";
}

export interface HostLine {
  key: string;
  host: string;
  org_name: string | null;
  own: boolean;
  version: string | null;
  /** trechos ligados, em % da largura do período */
  segments: { left: number; width: number; end: SessionEnd; from: string; to: string }[];
  /** frases curtas: "ligado agora", "parou de repente às 17:31"... */
  notes: string[];
}

export function hostLines(sessions: OpSession[], from: string, to: string, now: string): HostLine[] {
  const a = ms(from);
  const b = Math.min(ms(to), ms(now));
  const span = ms(to) - a;
  const groups = new Map<string, OpSession[]>();
  for (const s of sessions) {
    const key = `${s.org_id}|${s.host}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const lines: HostLine[] = [];
  for (const [key, list] of groups) {
    list.sort((x, y) => ms(x.started_at) - ms(y.started_at));
    const segments: HostLine["segments"] = [];
    const notes: string[] = [];
    for (const s of list) {
      const end = sessionEnd(s, now);
      const s0 = Math.max(ms(s.started_at), a);
      const s1 = Math.min(end === "running" ? b : ms(s.last_seen_at), b);
      if (s1 <= s0) continue;
      segments.push({
        left: ((s0 - a) / span) * 100,
        width: Math.max(0.4, ((s1 - s0) / span) * 100),
        end,
        from: s.started_at,
        to: end === "running" ? now : s.last_seen_at,
      });
      if (end === "abrupt" && ms(s.last_seen_at) <= b) notes.push(`parou de repente às ${hhmm(ms(s.last_seen_at))}`);
    }
    const last = list[list.length - 1];
    const lastEnd = sessionEnd(last, now);
    if (lastEnd === "running") notes.unshift("ligado agora");
    else if (lastEnd === "stopped" && ms(last.last_seen_at) <= b) notes.push(`desligado às ${hhmm(ms(last.last_seen_at))}`);
    lines.push({
      key,
      host: last.host,
      org_name: last.org_name,
      own: last.own,
      version: last.version ?? list.map((x) => x.version).find(Boolean) ?? null,
      segments,
      notes,
    });
  }
  // o próprio escritório primeiro; depois por escritório e computador
  return lines.sort(
    (x, y) => Number(y.own) - Number(x.own) || (x.org_name ?? "").localeCompare(y.org_name ?? "") || x.host.localeCompare(y.host),
  );
}

/** Marcas de hora para a régua da faixa (a cada 3 h, ou 1 h em períodos curtos). */
export function rulerTicks(from: string, to: string): { left: number; label: string }[] {
  const a = ms(from);
  const span = ms(to) - a;
  const step = span <= 6 * 3_600_000 ? 3_600_000 : 3 * 3_600_000;
  const ticks: { left: number; label: string }[] = [];
  for (let t = a; t <= a + span; t += step) ticks.push({ left: ((t - a) / span) * 100, label: hhmm(t).slice(0, 2) + "h" });
  return ticks;
}

export const hhmmOf = (iso: string | null | undefined) => (iso ? hhmm(ms(iso)) : "");
