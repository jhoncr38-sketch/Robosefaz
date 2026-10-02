// Trabalho parado esperando um computador desligado. Três casos:
// - repasse: o PC que pegou o trabalho não tem o certificado do cliente (entra em skip_hosts) e
//   os outros PCs do escritório estão desligados (01/10: Frigorífico esperou 2,5 h este notebook
//   dormindo; a 4N esperou o PC do Alex);
// - nenhum outro PC: só existe o computador que não tem o certificado;
// - nenhum robô ligado: a fila só anda quando um computador com o robô for ligado.

import { formatDateTime } from "./format.ts";
import type { JobStatus } from "./types.ts";

/** Sem sinal há mais que isso = desligado (o robô dá sinal a cada 30 s). */
export const ONLINE_MS = 2 * 60_000;

export interface Computer {
  hostname: string;
  last_seen_at: string;
  online: boolean;
}

/** "Alex-17420" -> "Alex" (o worker_id leva o número do processo), como worker_host() no banco. */
export function hostOf(hb: { hostname?: string | null; worker_id: string }): string {
  return hb.hostname?.trim() || hb.worker_id.replace(/-\d+$/, "");
}

/** Último sinal de cada computador (o robô grava uma linha a cada vez que liga). */
export function computersFrom(
  heartbeats: { hostname?: string | null; worker_id: string; status?: string | null; last_seen_at: string }[],
  now: number,
): Computer[] {
  const latest = new Map<string, (typeof heartbeats)[number]>();
  for (const hb of heartbeats) {
    const host = hostOf(hb);
    if (!host) continue;
    const prev = latest.get(host);
    if (!prev || hb.last_seen_at > prev.last_seen_at) latest.set(host, hb);
  }
  return [...latest.entries()]
    .map(([hostname, hb]) => ({
      hostname,
      last_seen_at: hb.last_seen_at,
      online: hb.status !== "stopped" && now - Date.parse(hb.last_seen_at) < ONLINE_MS,
    }))
    .sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1));
}

export type PcWait =
  /** só os PCs da lista podem pegar o trabalho, e estão desligados */
  | { kind: "handover"; without: string[]; waitingFor: Computer[] }
  /** nenhum outro PC do escritório conhecido: o certificado precisa ser instalado em algum */
  | { kind: "no_other_pc"; without: string[] }
  /** nenhum robô ligado */
  | { kind: "none_online"; lastSeen: Computer | null };

const IDLE: JobStatus[] = ["queued", "waiting_sefaz"];

/** null = algum computador ligado pode pegar o trabalho (ou ele já está com um). */
export function pcWait(
  job: { status: JobStatus; locked_by: string | null; skip_hosts?: string[] | null },
  computers: Computer[],
): PcWait | null {
  if (job.locked_by || !IDLE.includes(job.status)) return null;
  const without = job.skip_hosts ?? [];
  const candidates = computers.filter((c) => !without.includes(c.hostname));
  if (candidates.some((c) => c.online)) return null;
  if (without.length > 0) {
    return candidates.length === 0 ? { kind: "no_other_pc", without } : { kind: "handover", without, waitingFor: candidates };
  }
  return { kind: "none_online", lastSeen: computers[0] ?? null };
}

/** "há 29 min", "há 2h", "desde 30/09/2026 18:06" */
export function offlineSince(c: Computer, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(c.last_seen_at)) / 60_000));
  if (minutes < 60) return `há ${Math.max(minutes, 1)} min`;
  if (minutes < 24 * 60) return `há ${Math.floor(minutes / 60)}h`;
  return `desde ${formatDateTime(c.last_seen_at)}`;
}

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ou ${names[names.length - 1]}`;

/** Trabalhos que esperam a mesma coisa (o mesmo PC ser ligado, por exemplo) ficam juntos. */
export interface PcWaitGroup<J> {
  key: string;
  kind: PcWait["kind"];
  /** computadores que podem pegar, todos desligados */
  waitingFor: Computer[];
  /** computadores que tentaram e não têm o certificado */
  without: string[];
  lastSeen: Computer | null;
  jobs: J[];
}

export function groupWaits<J>(items: { job: J; wait: PcWait }[]): PcWaitGroup<J>[] {
  const groups = new Map<string, PcWaitGroup<J>>();
  for (const { job, wait } of items) {
    const waitingFor = wait.kind === "handover" ? wait.waitingFor : [];
    const without = wait.kind === "none_online" ? [] : wait.without;
    const key =
      wait.kind === "handover"
        ? `h:${waitingFor.map((c) => c.hostname).sort().join(",")}`
        : wait.kind === "no_other_pc"
          ? `n:${[...without].sort().join(",")}`
          : "none";
    const group = groups.get(key) ?? {
      key,
      kind: wait.kind,
      waitingFor,
      without: [],
      lastSeen: wait.kind === "none_online" ? wait.lastSeen : null,
      jobs: [],
    };
    for (const host of without) if (!group.without.includes(host)) group.without.push(host);
    group.jobs.push(job);
    groups.set(key, group);
  }
  // o que tem mais trabalho esperando primeiro
  return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length);
}

/**
 * Textos do grupo: o que está acontecendo e o que fazer, em passos. `client`: nome do cliente
 * quando o grupo tem um trabalho só ("o certificado da 4N"). `action` = os passos numa frase.
 */
export function groupText(
  group: PcWaitGroup<unknown>,
  now: Date,
  client?: string,
): { title: string; status: string; steps: string[]; action: string } {
  const cert = client ? `o certificado de ${client}` : "os certificados destes clientes";
  const without = list(group.without);
  const done = (t: { title: string; status: string; steps: string[] }) => ({ ...t, action: t.steps.join(" ") });
  switch (group.kind) {
    case "handover": {
      const names = group.waitingFor.map((c) => c.hostname);
      return done({
        title: `Aguardando o PC ${list(names)}`,
        status:
          group.waitingFor.length === 1
            ? `desligado ${offlineSince(group.waitingFor[0], now)}`
            : group.waitingFor.map((c) => `${c.hostname} desligado ${offlineSince(c, now)}`).join(" · "),
        // quem já tentou fica de fora do trabalho: depois de instalar o certificado, só o
        // Reprocessar (que zera a lista) devolve o trabalho a ele
        steps: [
          `Ligue o PC ${list(names)}: o trabalho continua sozinho.`,
          `Ou instale ${cert} em ${without}, cancele o trabalho na fila e clique em Reprocessar.`,
        ],
      });
    }
    case "no_other_pc":
      return done({
        title: "Nenhum computador com o certificado",
        status: `${without} não tem ${cert}`,
        steps: [
          `Instale ${cert} em ${without} ou em outro computador com o robô.`,
          "Depois, cancele o trabalho na fila e clique em Reprocessar.",
        ],
      });
    case "none_online":
      return done({
        title: "Nenhum robô ligado",
        status: group.lastSeen ? `último sinal de ${group.lastSeen.hostname} ${offlineSince(group.lastSeen, now)}` : "nenhum computador deu sinal ainda",
        steps: ["Ligue um computador com o robô, ou abra o robô pelo ícone ao lado do relógio do Windows."],
      });
  }
}
