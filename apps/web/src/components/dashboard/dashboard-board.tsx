"use client";

import {
  ArrowRight,
  CalendarClock,
  CircleCheck,
  Hourglass,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { JobStatusBadge } from "@/components/status-badge";
import { useNow } from "@/hooks/use-now";
import { useRealtimeJobs } from "@/hooks/use-realtime-jobs";
import { SEFAZ_PHASE, useWaitingSince } from "@/hooks/use-waiting-since";
import { formatCompetence } from "@/lib/competence";
import {
  COMPETENCE_STATUS_COLOR,
  COMPETENCE_STATUS_LABEL,
  COMPETENCE_STATUS_ORDER,
  competenceStatusOf,
  countByStatus,
  latestJobByClient,
} from "@/lib/competence-status";
import { formatClock, formatDate, formatShortAgo } from "@/lib/format";
import { JOB_STEPS, jobStepIndex } from "@/lib/job-steps";
import { isJobRunning, MANUAL_JOB_STATUSES, TASK_TYPE_LABEL } from "@/lib/status";
import type { AutomationJob, ExportTaskType } from "@/lib/types";
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

export interface DashboardTotals {
  downloads: number;
  completed: number;
  failed: number;
}

const OP_TAG: Record<ExportTaskType, string> = {
  NFCE_EXPORT: "NFC-e",
  NFE_ISSUED_EXPORT: "Emit.",
  NFE_RECEIVED_EXPORT: "Receb.",
};

const EXEC_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_44px] gap-3 sm:grid-cols-[minmax(120px,2fr)_60px_minmax(150px,1.2fr)_minmax(130px,1.2fr)_56px]";

function clientName(job: AutomationJob, names: Map<string, string>): string {
  return job.clients?.trade_name || job.clients?.legal_name || names.get(job.client_id) || "Cliente";
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("rounded-xl border bg-card", className)}>{children}</section>;
}

export function DashboardBoard({
  competence,
  initialJobs,
  clients,
  totals,
  certs,
  hostnames,
  canRun,
}: {
  competence: string;
  initialJobs: AutomationJob[];
  clients: DashboardClient[];
  totals: DashboardTotals;
  certs: DashboardCertSummary;
  hostnames: Record<string, string>;
  canRun: boolean;
}) {
  const { jobs } = useRealtimeJobs(initialJobs);
  const now = useNow();
  const waitingSince = useWaitingSince(jobs);
  const names = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const compLabel = formatCompetence(competence);
  const scheduleHref = `/automation?competence=${competence}&select=pending`;

  // situação de cada cliente ativo na competência
  const latest = useMemo(() => latestJobByClient(jobs, competence), [jobs, competence]);
  const statuses = clients.map((c) => competenceStatusOf(latest.get(c.id)));
  const counts = countByStatus(statuses);
  const pendingClients = clients.filter((_, i) => statuses[i] === "none");
  const failedInComp = counts.failed;

  const running = jobs
    .filter((j) => isJobRunning(j.status))
    .sort((a, b) => (a.started_at ?? a.created_at).localeCompare(b.started_at ?? b.created_at))[0];
  const queued = jobs.filter((j) => j.status === "queued").length;
  const sefazJobs = jobs.filter((j) => SEFAZ_PHASE.includes(j.status));
  const nextSefaz = [...sefazJobs]
    .filter((j) => j.next_check_at)
    .sort((a, b) => (a.next_check_at ?? "").localeCompare(b.next_check_at ?? ""))[0];

  // precisa de atenção
  const attention: { key: string; icon: LucideIcon; tone: string; title: string; sub: string; action: string; href: string }[] = [];
  for (const j of jobs.filter((x) => MANUAL_JOB_STATUSES.includes(x.status) || x.status === "certificate_required").slice(0, 3)) {
    attention.push({
      key: `manual-${j.id}`,
      icon: TriangleAlert,
      tone: "bg-[#fdeee3] text-[#b4530f]",
      title: `${clientName(j, names)} precisa de intervenção`,
      sub: `${formatCompetence(j.competence)} · ${j.manual_action_message || j.last_message || "veja a fila"}`,
      action: "Abrir fila",
      href: "/queue",
    });
  }
  if (now !== null) {
    const oldest = sefazJobs
      .map((j) => ({ job: j, since: waitingSince[j.id] ?? j.updated_at }))
      .sort((a, b) => a.since.localeCompare(b.since))[0];
    if (oldest && now - new Date(oldest.since).getTime() > 2 * 3600_000) {
      const hours = Math.floor((now - new Date(oldest.since).getTime()) / 3600_000);
      attention.push({
        key: "sefaz",
        icon: Hourglass,
        tone: "bg-[#fdf4e3] text-[#b7791f]",
        title: `${clientName(oldest.job, names)} aguarda SEFAZ há ${hours}h`,
        sub: `${formatCompetence(oldest.job.competence)} · o robô segue consultando`,
        action: "Ver fila",
        href: "/queue",
      });
    }
  }
  if (failedInComp > 0) {
    attention.push({
      key: "failed",
      icon: TriangleAlert,
      tone: "bg-[#fdecec] text-[#b42323]",
      title: `${failedInComp} cliente(s) com erro em ${compLabel}`,
      sub: "Veja o motivo e reprocesse",
      action: "Ver erros",
      href: "/errors",
    });
  }
  if (canRun && pendingClients.length > 0) {
    attention.push({
      key: "pending",
      icon: CalendarClock,
      tone: "bg-[#e6f4ec] text-primary",
      title: `${pendingClients.length} cliente(s) sem solicitação em ${compLabel}`,
      sub: pendingClients
        .slice(0, 4)
        .map((c) => c.name.split(" ")[0])
        .join(", ") + (pendingClients.length > 4 ? "…" : ""),
      action: "Agendar",
      href: scheduleHref,
    });
  }
  if (certs.expired + certs.expiring > 0) {
    attention.push({
      key: "certs",
      icon: ShieldAlert,
      tone: "bg-[#fdf4e3] text-[#b7791f]",
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
          totals={totals}
          scheduleHref={canRun && pendingClients.length > 0 ? scheduleHref : null}
        />
        <RecentExecutions jobs={jobs} names={names} competence={competence} now={now} />
      </div>

      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
        <NowCard running={running} queued={queued} nextSefaz={nextSefaz} names={names} hostnames={hostnames} now={now} />

        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 px-[18px] pt-3.5 pb-2.5">
            <span className="flex-1 text-[14.5px] font-semibold">Precisa de atenção</span>
            {attention.length > 0 ? (
              <span className="rounded-[10px] bg-[#fdf4e3] px-[7px] py-px font-mono text-[11.5px] text-[#9a6205]">
                {attention.length}
              </span>
            ) : null}
          </div>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2.5 border-t border-[#f2f2ef] px-[18px] py-3 text-[12.5px] text-[#4a4b46]">
              <CircleCheck className="size-4 text-[#2ea062]" /> Nada pendente. Tudo em dia.
            </div>
          ) : (
            attention.map((a) => (
              <div key={a.key} className="flex items-center gap-3 border-t border-[#f2f2ef] px-[18px] py-[11px]">
                <div className={cn("grid size-7 shrink-0 place-items-center rounded-[7px]", a.tone)}>
                  <a.icon className="size-3.5" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-[12.5px] font-medium">{a.title}</p>
                  <p className="truncate text-[11.5px] text-[#7a7b75]" title={a.sub}>
                    {a.sub}
                  </p>
                </div>
                <Link
                  href={a.href}
                  className="shrink-0 rounded-md border border-[#d3ebdc] px-[9px] py-1 text-xs font-medium whitespace-nowrap text-primary hover:bg-[#eef7f1] hover:no-underline"
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
  totals,
  scheduleHref,
}: {
  compLabel: string;
  total: number;
  counts: ReturnType<typeof countByStatus>;
  totals: DashboardTotals;
  scheduleHref: string | null;
}) {
  const present = COMPETENCE_STATUS_ORDER.filter((s) => counts[s] > 0);
  return (
    <Card className="flex flex-col gap-[18px] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-[1_1_220px] flex-col gap-0.5">
          <p className="text-xs text-[#7a7b75]">Competência atual</p>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-mono text-[26px] font-semibold tracking-[-0.02em]">{compLabel}</span>
            <span className="text-[13px] whitespace-nowrap text-muted-foreground">
              {counts.done} de {total} cliente(s) concluído(s)
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-7 gap-y-3">
          <HeroStat label="Downloads disponíveis" value={totals.downloads} href="/downloads" />
          <HeroStat label="Concluídos (total)" value={totals.completed} href="/history?status=completed" />
          <HeroStat
            label="Erros"
            value={totals.failed}
            href="/errors"
            className={totals.failed === 0 ? "text-primary" : "text-[#b42323]"}
          />
        </div>
      </div>

      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px] bg-[#f0f0ec]" aria-hidden>
        {total > 0
          ? present.map((s) => (
              <div key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: COMPETENCE_STATUS_COLOR[s] }} />
            ))
          : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {total === 0 ? (
          <span className="text-[12.5px] text-muted-foreground">Nenhum cliente ativo cadastrado.</span>
        ) : (
          present.map((s) => (
            <div key={s} className="flex items-center gap-[7px] text-[12.5px] text-[#4a4b46]">
              <span className="size-2 rounded-[2px]" style={{ background: COMPETENCE_STATUS_COLOR[s] }} />
              {COMPETENCE_STATUS_LABEL[s]}
              <span className="font-mono font-medium text-foreground">{counts[s]}</span>
            </div>
          ))
        )}
        <div className="flex-1" />
        {scheduleHref ? (
          <Link href={scheduleHref} className="flex items-center gap-1 text-[12.5px] font-medium text-primary">
            Agendar pendentes <ArrowRight className="size-[13px]" />
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function HeroStat({ label, value, href, className }: { label: string; value: number; href: string; className?: string }) {
  return (
    <Link href={href} className="flex flex-col gap-0.5 text-foreground hover:no-underline">
      <span className="text-xs text-[#7a7b75]">{label}</span>
      <span className={cn("text-xl font-semibold tabular-nums", className)}>{value}</span>
    </Link>
  );
}

type ExecTab = "all" | "active" | "competence";

function RecentExecutions({
  jobs,
  names,
  competence,
  now,
}: {
  jobs: AutomationJob[];
  names: Map<string, string>;
  competence: string;
  now: number | null;
}) {
  const [tab, setTab] = useState<ExecTab>("all");
  const final = ["completed", "failed", "cancelled"];
  const list = [...jobs]
    .filter((j) => (tab === "active" ? !final.includes(j.status) : tab === "competence" ? j.competence === competence : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10);
  const tabs: [ExecTab, string][] = [
    ["all", "Todas"],
    ["active", "Em andamento"],
    ["competence", formatCompetence(competence)],
  ];

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[#efefeb] px-[18px] py-3.5">
        <p className="flex-1 text-[14.5px] font-semibold">Últimas execuções</p>
        <div className="flex gap-1 rounded-[7px] bg-[#f3f3f0] p-0.5" role="tablist">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-xs",
                tab === key ? "bg-white text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
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
          "border-b border-[#efefeb] bg-[#fafaf8] px-[18px] py-[9px] text-[11.5px] tracking-[0.04em] text-[#7a7b75] uppercase",
        )}
      >
        <span>Cliente</span>
        <span className="hidden sm:block">Comp.</span>
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
              "items-center border-b border-[#f2f2ef] px-[18px] py-2.5 text-[13px] text-foreground last:border-b-0 hover:bg-[#fafaf8] hover:no-underline",
            )}
          >
            <span className="truncate font-medium">{clientName(j, names)}</span>
            <span className="hidden font-mono text-[12.5px] text-[#4a4b46] sm:block">{formatCompetence(j.competence)}</span>
            <span className="hidden gap-1 sm:flex">
              {j.operations.map((o) => (
                <span
                  key={o}
                  title={TASK_TYPE_LABEL[o]}
                  className="rounded bg-[#f2f2ef] px-[5px] py-0.5 font-mono text-[10.5px] whitespace-nowrap text-[#4a4b46]"
                >
                  {OP_TAG[o] ?? o}
                </span>
              ))}
            </span>
            <span className="min-w-0">
              <JobStatusBadge status={j.status} />
            </span>
            <span className="text-right text-xs text-[#7a7b75]">
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
        {running ? <span className="live-dot" /> : <span className="size-2 rounded-full bg-[#c9c9c4]" />}
        <span className="flex-1 text-[14.5px] font-semibold">Agora</span>
        <Link href="/queue" className="text-xs text-[#7a7b75]">
          Fila: {queued}
        </Link>
      </div>

      {running ? (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="text-[13.5px] font-semibold">{clientName(running, names)}</p>
            <p className="text-xs text-[#7a7b75]">
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
                        done ? "border-[#2ea062] bg-[#2ea062]" : current ? "border-[#2ea062] bg-white" : "border-[#d9d9d4] bg-white",
                      )}
                    />
                    {i < JOB_STEPS.length - 1 ? (
                      <span className={cn("h-3.5 w-0.5", done ? "bg-[#2ea062]" : "bg-[#e8e8e4]")} />
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "flex flex-1 justify-between text-[12.5px]",
                      done || current ? "text-foreground" : "text-[#9a9b94]",
                      current && "font-semibold",
                    )}
                  >
                    <span>{label}</span>
                    <span className="font-mono text-[11.5px] font-normal text-[#7a7b75]">
                      {current && elapsed !== null ? formatClock(elapsed) : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          {running.last_message ? (
            <p className="-mt-1 truncate text-[11.5px] text-[#7a7b75]" title={running.last_message}>
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
        <div className="flex items-center gap-2.5 border-t border-dashed pt-3 text-[12.5px] text-[#4a4b46]">
          <Hourglass className="size-3.5 shrink-0 text-[#b7791f]" />
          <span className="min-w-0 flex-1 truncate">
            {clientName(nextSefaz, names)} aguarda SEFAZ · {formatCompetence(nextSefaz.competence)}
          </span>
          <span className="shrink-0 font-mono text-[11.5px] text-[#7a7b75]">
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
        <MiniStat value={certs.valid} label="Válidos" className="bg-[#f3faf6] [&>b]:text-[#1c5e3c] [&>span]:text-[#4a6b58]" />
        <MiniStat
          value={certs.expiring}
          label="Vencem em 30d"
          className={certs.expiring > 0 ? "bg-[#fdf4e3] [&>b]:text-[#9a6205]" : "bg-[#fafaf8]"}
        />
        <MiniStat
          value={certs.expired}
          label="Vencidos"
          className={certs.expired > 0 ? "bg-[#fdecec] [&>b]:text-[#b42323]" : "bg-[#fafaf8]"}
        />
      </div>
      {certs.next ? (
        <div className="flex items-center gap-2 text-[12.5px] text-[#4a4b46]">
          <ShieldCheck className="size-3.5 shrink-0 text-primary" />
          <Link href={`/clients/${certs.next.clientId}`} className="min-w-0 flex-1 truncate text-[#4a4b46]">
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
      <span className="text-[11px] text-[#7a7b75]">{label}</span>
    </div>
  );
}
