"use client";

import { CalendarPlus, CircleCheck, Download, Hand, Hourglass, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { JobStatusBadge } from "@/components/status-badge";
import { useNow } from "@/hooks/use-now";
import { useRealtimeJobs } from "@/hooks/use-realtime-jobs";
import { SEFAZ_PHASE } from "@/hooks/use-waiting-since";
import { formatCompetence } from "@/lib/competence";
import {
  competenceGroups,
  competenceStatusOf,
  countByStatus,
  isExportJob,
  latestJobByClient,
} from "@/lib/competence-status";
import { formatClock, formatDate, formatShortAgo } from "@/lib/format";
import { JOB_STEPS, jobStepIndex } from "@/lib/job-steps";
import { isJobRunning, MANUAL_JOB_STATUSES, TASK_TYPE_LABEL } from "@/lib/status";
import type { AutomationJob, JobOperation } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface DashboardClient {
  id: string;
  name: string;
}

export interface DashboardCertSummary {
  valid: number;
  expiring: number;
  expired: number;
  next: { clientId: string; name: string; validUntil: string } | null;
}

const OP_TAG: Record<JobOperation, string> = {
  NFCE_EXPORT: "NFC-e",
  NFE_ISSUED_EXPORT: "Emit.",
  NFE_RECEIVED_EXPORT: "Receb.",
  NFCE_CANCELED_EXPORT: "NFC-e canc.",
  NFE_ISSUED_CANCELED_EXPORT: "Emit. canc.",
  NFE_RECEIVED_CANCELED_EXPORT: "Receb. canc.",
  NFE_KEY_EXPORT: "Nota pela chave",
  EFD_CHECK: "EFD",
  MALHA_CHECK: "Malhas",
};

const EXEC_GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_44px] gap-3 sm:grid-cols-[minmax(120px,2fr)_minmax(150px,1.2fr)_minmax(150px,1.2fr)_56px]";

function clientName(job: AutomationJob, names: Map<string, string>): string {
  return job.clients?.trade_name || job.clients?.legal_name || names.get(job.client_id) || "Cliente";
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("rounded-xl border bg-card shadow-card", className)}>{children}</section>;
}

export function DashboardBoard({
  competence,
  initialJobs,
  clients,
  downloads,
  certs,
  hostnames,
  canRun,
}: {
  competence: string;
  initialJobs: AutomationJob[];
  clients: DashboardClient[];
  /** arquivos prontos para baixar */
  downloads: number;
  certs: DashboardCertSummary;
  hostnames: Record<string, string>;
  canRun: boolean;
}) {
  const { jobs } = useRealtimeJobs(initialJobs);
  const now = useNow();
  const names = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const compLabel = formatCompetence(competence);
  const scheduleHref = `/automation?competence=${competence}&select=pending`;

  // situação de cada cliente ativo na competência
  const latest = useMemo(() => latestJobByClient(jobs.filter(isExportJob), competence), [jobs, competence]);
  const statuses = clients.map((c) => competenceStatusOf(latest.get(c.id)));
  const counts = countByStatus(statuses);
  const pendingClients = clients.filter((_, i) => statuses[i] === "none");

  const running = jobs
    .filter((j) => isJobRunning(j.status))
    .sort((a, b) => (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at))[0];
  const queued = jobs.filter((j) => j.status === "queued").length;
  const sefazJobs = jobs.filter((j) => SEFAZ_PHASE.includes(j.status));
  const nextSefaz = [...sefazJobs]
    .filter((j) => j.next_check_at)
    .sort((a, b) => (a.next_check_at ?? "").localeCompare(b.next_check_at ?? ""))[0];

  // precisa de atenção: só o que pede uma ação sua (erros e pendentes já estão no card da competência)
  const attention: { key: string; icon: LucideIcon; tone: string; title: string; sub: string; action: string; href: string }[] = [];
  for (const j of jobs.filter((x) => MANUAL_JOB_STATUSES.includes(x.status) || x.status === "certificate_required").slice(0, 3)) {
    attention.push({
      key: `manual-${j.id}`,
      icon: Hand,
      tone: "bg-(--c-fdeee3) text-(--c-b4530f)",
      title: `${clientName(j, names)} precisa de intervenção`,
      sub: `${formatCompetence(j.competence)} · ${j.manual_action_message || j.last_message || "veja a fila"}`,
      action: "Abrir fila",
      href: "/queue?aba=intervencao",
    });
  }
  if (certs.expired + certs.expiring > 0) {
    attention.push({
      key: "certs",
      icon: ShieldAlert,
      tone: certs.expired > 0 ? "bg-(--c-fdecec) text-(--c-b42323)" : "bg-(--c-fff4e5) text-(--c-d97706)",
      title:
        certs.expired > 0
          ? `${certs.expired} certificado(s) vencido(s)`
          : `${certs.expiring} certificado(s) vencem em 30 dias`,
      sub: "Sem certificado válido o robô não acessa o SIAT",
      action: "Ver",
      href: "/certificates",
    });
  }

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_580px] flex-col gap-5">
        <CompetenceHero
          compLabel={compLabel}
          total={clients.length}
          counts={counts}
          downloads={downloads}
          pending={canRun ? pendingClients.length : 0}
          scheduleHref={scheduleHref}
        />
        <RecentExecutions jobs={jobs} names={names} now={now} />
      </div>

      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
        <NowCard running={running} queued={queued} nextSefaz={nextSefaz} names={names} hostnames={hostnames} now={now} />

        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 px-[18px] pt-3.5 pb-2.5">
            <span className="flex-1 text-[14.5px] font-semibold">Precisa de atenção</span>
            {attention.length > 0 ? (
              <span className="rounded-[10px] bg-(--c-fdf4e3) px-[7px] py-px font-mono text-[11.5px] text-(--c-9a6205)">
                {attention.length}
              </span>
            ) : null}
          </div>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2.5 border-t border-(--c-f2f2ef) px-[18px] py-3 text-[12.5px] text-(--c-4a4b46)">
              <CircleCheck className="size-4 text-(--c-2ea062)" /> Nada pendente. Tudo em dia.
            </div>
          ) : (
            attention.map((a) => (
              <div key={a.key} className="flex items-center gap-3 border-t border-(--c-f2f2ef) px-[18px] py-[11px]">
                <div className={cn("grid size-7 shrink-0 place-items-center rounded-[7px]", a.tone)}>
                  <a.icon className="size-3.5" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-[12.5px] font-medium">{a.title}</p>
                  <p className="truncate text-[11.5px] text-(--c-6b6c66)" title={a.sub}>
                    {a.sub}
                  </p>
                </div>
                <Link
                  href={a.href}
                  className="shrink-0 rounded-md border border-(--c-d3ebdc) px-[9px] py-1 text-xs font-medium whitespace-nowrap text-primary hover:bg-(--c-eef7f1) hover:no-underline"
                >
                  {a.action}
                </Link>
              </div>
            ))
          )}
        </Card>

        <CertificatesCard certs={certs} now={now} />
      </div>
    </div>
  );
}

function CompetenceHero({
  compLabel,
  total,
  counts,
  downloads,
  pending,
  scheduleHref,
}: {
  compLabel: string;
  total: number;
  counts: ReturnType<typeof countByStatus>;
  downloads: number;
  /** clientes sem pedido que o usuário pode agendar (0 = sem botão) */
  pending: number;
  scheduleHref: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const groups = competenceGroups(counts);
  const pct = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const shown = groups.map((g, i) => (g.n > 0 ? i : -1)).filter((i) => i >= 0);
  const first = shown[0];
  const last = shown[shown.length - 1];
  return (
    <Card className="flex flex-col gap-[18px] p-5">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="flex flex-[1_1_260px] flex-col gap-1">
          <p className="text-xs text-(--c-6b6c66)">Competência</p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[26px] font-semibold tracking-[-0.02em]">{compLabel}</span>
            <span className="text-[13.5px] text-(--c-4a4b46)">
              <b className="font-semibold text-foreground">{pct}%</b> concluído · {counts.done} de {total} cliente(s)
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/downloads" className="flex items-center gap-1.5 text-[13px] whitespace-nowrap text-(--c-3d3e3a)">
            <Download className="size-3.5 text-(--c-6b6c66)" />
            <b className="font-mono text-[13px] font-semibold">{downloads}</b> para baixar
          </Link>
          {pending > 0 ? (
            <Link
              href={scheduleHref}
              className="flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-[13.5px] font-medium whitespace-nowrap text-primary-foreground hover:bg-(--c-196640) hover:no-underline"
            >
              <CalendarPlus className="size-[15px]" /> Agendar {pending} pendente{pending === 1 ? "" : "s"}
            </Link>
          ) : null}
        </div>
      </div>

      {total === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Nenhum cliente ativo cadastrado.</p>
      ) : (
        <>
          {/* barra contínua: concluído, em andamento e com problema; o fundo é o "não solicitado" */}
          <div className="flex h-2 rounded-[4px] bg-(--c-f0f0ec)" onMouseLeave={() => setHover(null)}>
            {groups.map((g, i) =>
              g.n > 0 ? (
                <div
                  key={g.key}
                  onMouseEnter={() => setHover(i)}
                  className="relative cursor-default transition-opacity duration-150"
                  style={{
                    width: `${(g.n / total) * 100}%`,
                    background: g.fill,
                    opacity: hover === null || hover === i ? 1 : 0.35,
                    borderRadius: `${i === first ? 4 : 0}px ${i === last ? 4 : 0}px ${i === last ? 4 : 0}px ${i === first ? 4 : 0}px`,
                  }}
                >
                  {hover === i ? (
                    <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-[7px] bg-[#1c1d1b] px-2.5 py-[7px] text-xs leading-[1.4] whitespace-nowrap text-white shadow-[0_6px_18px_rgba(0,0,0,.18)]">
                      <b className="font-semibold">
                        {g.label} · {g.n}
                      </b>
                      <br />
                      <span className="text-[#d4d4cf]">{g.sub}</span>
                    </div>
                  ) : null}
                </div>
              ) : null,
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))]">
            {groups.map((g) => (
              <div key={g.key} className="flex min-w-0 flex-col gap-[3px]">
                <div className="flex items-center gap-[7px] text-[12.5px] text-(--c-4a4b46)">
                  <span className="size-2 shrink-0 rounded-[2px]" style={{ background: g.color }} />
                  {g.label}
                </div>
                <span
                  className={cn(
                    "font-mono text-lg font-semibold",
                    g.key === "problem" && g.n > 0 ? "text-(--c-b42323)" : "text-foreground",
                  )}
                >
                  {g.n}
                </span>
                <span className="truncate text-[11.5px] text-(--c-6b6c66)" title={g.sub}>
                  {g.sub}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

type ExecTab = "all" | "active";

function RecentExecutions({ jobs, names, now }: { jobs: AutomationJob[]; names: Map<string, string>; now: number | null }) {
  const [tab, setTab] = useState<ExecTab>("all");
  const final = ["completed", "failed", "cancelled"];
  const list = [...jobs]
    .filter((j) => (tab === "active" ? !final.includes(j.status) : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10);
  const tabs: [ExecTab, string][] = [
    ["all", "Todas"],
    ["active", "Em andamento"],
  ];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-(--c-efefeb) px-[18px] py-3.5">
        <p className="flex-1 text-[14.5px] font-semibold">Últimas execuções</p>
        <div className="flex gap-1 rounded-[7px] bg-(--c-f3f3f0) p-0.5" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-xs",
                tab === key ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Link href="/history" className="text-[12.5px] whitespace-nowrap text-primary hover:underline">
          Ver histórico
        </Link>
      </div>
      <div
        className={cn(
          EXEC_GRID,
          "border-b border-(--c-efefeb) bg-(--c-fafaf8) px-[18px] py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
        )}
      >
        <span>Cliente</span>
        <span className="hidden sm:block">Operações</span>
        <span>Status</span>
        <span className="text-right">Quando</span>
      </div>
      {list.length === 0 ? (
        <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">
          {tab === "active" ? "Nada em andamento agora." : "Nenhuma execução ainda."}
        </p>
      ) : (
        list.map((j) => (
          <Link
            key={j.id}
            href={`/history/${j.id}`}
            className={cn(
              EXEC_GRID,
              "items-center border-b border-(--c-f2f2ef) px-[18px] py-2.5 text-[13px] text-foreground last:border-b-0 hover:bg-(--c-fafaf8) hover:no-underline",
            )}
          >
            <span className="truncate font-medium" title={`${clientName(j, names)} · ${formatCompetence(j.competence)}`}>
              {clientName(j, names)}
            </span>
            <span className="hidden gap-1 overflow-hidden sm:flex">
              {j.operations.map((o) => (
                <span
                  key={o}
                  title={TASK_TYPE_LABEL[o]}
                  className="rounded bg-(--c-f2f2ef) px-[5px] py-0.5 font-mono text-[10.5px] whitespace-nowrap text-(--c-4a4b46)"
                >
                  {OP_TAG[o] ?? o}
                </span>
              ))}
            </span>
            <span className="min-w-0 overflow-hidden">
              <JobStatusBadge status={j.status} />
            </span>
            <span className="text-right text-xs text-(--c-6b6c66)">
              {now === null ? "" : formatShortAgo(j.created_at, new Date(now))}
            </span>
          </Link>
        ))
      )}
    </Card>
  );
}

function NowCard({
  running,
  queued,
  nextSefaz,
  names,
  hostnames,
  now,
}: {
  running: AutomationJob | undefined;
  queued: number;
  nextSefaz: AutomationJob | undefined;
  names: Map<string, string>;
  hostnames: Record<string, string>;
  now: number | null;
}) {
  const step = running ? jobStepIndex(running.status) : -1;
  const elapsed = running?.started_at && now !== null ? (now - new Date(running.started_at).getTime()) / 1000 : null;
  const checkIn = nextSefaz?.next_check_at && now !== null ? (new Date(nextSefaz.next_check_at).getTime() - now) / 1000 : null;

  return (
    <Card className="flex flex-col gap-3.5 px-[18px] py-4">
      <div className="flex items-center gap-2">
        {running ? <span className="size-2 shrink-0 rounded-full bg-(--c-2ea062)" /> : <span className="size-2 rounded-full bg-(--c-c9c9c4)" />}
        <span className="flex-1 text-[14.5px] font-semibold">Agora</span>
        <Link href="/queue" className="text-xs text-(--c-6b6c66)">
          Fila: {queued}
        </Link>
      </div>

      {running ? (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="text-[13.5px] font-semibold">{clientName(running, names)}</p>
            <p className="text-xs text-(--c-6b6c66)">
              {formatCompetence(running.competence)} · {running.operations.map((o) => TASK_TYPE_LABEL[o]).join(", ")}
              {running.locked_by && hostnames[running.locked_by] ? ` · ${hostnames[running.locked_by]}` : ""}
            </p>
          </div>
          <ol className="flex flex-col">
            {JOB_STEPS.map((label, i) => {
              const done = i < step;
              const current = i === step;
              return (
                <li key={label} className="flex items-start gap-2.5">
                  <div className="flex w-3.5 flex-col items-center">
                    <span
                      className={cn(
                        "mt-[3px] box-border size-3 rounded-full border-2",
                        done ? "border-(--c-2ea062) bg-(--c-2ea062)" : current ? "border-(--c-2ea062) bg-card" : "border-(--c-d9d9d4) bg-card",
                      )}
                    />
                    {i < JOB_STEPS.length - 1 ? (
                      <span className={cn("h-3.5 w-0.5", done ? "bg-(--c-2ea062)" : "bg-(--c-e8e8e4)")} />
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "flex flex-1 justify-between text-[12.5px]",
                      done || current ? "text-foreground" : "text-(--c-6b6c66)",
                      current && "font-semibold",
                    )}
                  >
                    <span>{label}</span>
                    <span className="font-mono text-[11.5px] font-normal text-(--c-6b6c66)">
                      {current && elapsed !== null ? formatClock(elapsed) : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          {running.last_message ? (
            <p className="-mt-1 truncate text-[11.5px] text-(--c-6b6c66)" title={running.last_message}>
              {running.last_message}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          {queued > 0 ? `${queued} cliente(s) na fila; o robô começa assim que estiver livre.` : "Nenhum cliente em processamento."}
        </p>
      )}

      {nextSefaz ? (
        <div className="flex items-center gap-2.5 border-t border-dashed pt-3 text-[12.5px] text-(--c-4a4b46)">
          <Hourglass className="size-3.5 shrink-0 text-(--c-b7791f)" />
          <span className="min-w-0 flex-1 truncate">
            {clientName(nextSefaz, names)} aguarda SEFAZ · {formatCompetence(nextSefaz.competence)}
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-(--c-6b6c66)">
            {checkIn === null ? "" : checkIn > 0 ? `consulta em ${formatClock(checkIn)}` : "consultando…"}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function CertificatesCard({ certs, now }: { certs: DashboardCertSummary; now: number | null }) {
  const days = certs.next && now !== null ? Math.ceil((new Date(certs.next.validUntil).getTime() - now) / 86_400_000) : null;
  return (
    <Card className="flex flex-col gap-3 px-[18px] py-4">
      <div className="flex items-center">
        <span className="flex-1 text-[14.5px] font-semibold">Certificados</span>
        <Link href="/certificates" className="text-[12.5px] text-primary hover:underline">
          Gerenciar
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat value={certs.valid} label="Válidos" className="bg-(--c-f5f5f1) [&>b]:text-(--c-1c1d1b) [&>span]:text-(--c-6b6c66)" />
        <MiniStat
          value={certs.expiring}
          label="Vencem em 30d"
          className={certs.expiring > 0 ? "bg-(--c-fff4e5) [&>b]:text-(--c-b45309)" : "bg-(--c-fafaf8)"}
        />
        <MiniStat
          value={certs.expired}
          label="Vencidos"
          className={certs.expired > 0 ? "bg-(--c-fdecec) [&>b]:text-(--c-b42323)" : "bg-(--c-fafaf8)"}
        />
      </div>
      {certs.next ? (
        <div className="flex items-center gap-2 text-[12.5px] text-(--c-4a4b46)">
          <ShieldCheck className="size-3.5 shrink-0 text-primary" />
          <Link href={`/clients/${certs.next.clientId}`} className="min-w-0 flex-1 truncate text-(--c-4a4b46)">
            Próximo: {certs.next.name}
          </Link>
          <span className="shrink-0 font-mono text-xs">
            {formatDate(certs.next.validUntil)}
            {days !== null ? ` · ${days}d` : ""}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

function MiniStat({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-lg px-2.5 py-[9px]", className)}>
      <b className="text-lg font-semibold">{value}</b>
      <span className="text-[11px] text-(--c-6b6c66)">{label}</span>
    </div>
  );
}
