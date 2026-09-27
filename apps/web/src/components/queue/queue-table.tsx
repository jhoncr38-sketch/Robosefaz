"use client";

import { AlertTriangle, Radio } from "lucide-react";
import { useMemo, useState } from "react";

import { ListCard, ListEmptyText, ListHead, ListRow, ListToolbar, PrimaryCell, Segmented } from "@/components/data-list";
import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { JobStatusBadge } from "@/components/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { useRealtimeJobs } from "@/hooks/use-realtime-jobs";
import { SEFAZ_PHASE, useWaitingSince } from "@/hooks/use-waiting-since";
import { formatCompetence } from "@/lib/competence";
import { formatDuration } from "@/lib/format";
import { FINAL_JOB_STATUSES, isJobRunning, JOB_STATUS_LABEL, MANUAL_JOB_STATUSES } from "@/lib/status";
import type { AutomationJob, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "active" | "waiting" | "manual" | "finished" | "all";

function matches(tab: Tab, job: AutomationJob): boolean {
  switch (tab) {
    case "active":
      return job.status === "queued" || isJobRunning(job.status);
    case "waiting":
      return job.status === "waiting_sefaz";
    case "manual":
      return MANUAL_JOB_STATUSES.includes(job.status) || job.status === "certificate_required";
    case "finished":
      return FINAL_JOB_STATUSES.includes(job.status);
    default:
      return true;
  }
}

/** Tempo em duas partes: quanto o robô trabalhou e há quanto tempo espera a SEFAZ. */
function JobTime({ job, waitingSince, now }: { job: AutomationJob; waitingSince?: string; now: number | null }) {
  if (!job.started_at) return <span className="text-muted-foreground">—</span>;
  if (now === null) return null;
  const nowIso = new Date(now).toISOString();
  if (SEFAZ_PHASE.includes(job.status) && waitingSince) {
    return (
      <div className="space-y-0.5 leading-tight">
        <p>
          <span className="text-muted-foreground">Robô </span>
          {formatDuration(job.started_at, waitingSince)}
        </p>
        <p className="text-(--c-9a6205)">
          <span className="text-(--c-9a6205)/70">SEFAZ há </span>
          {formatDuration(waitingSince, nowIso)}
        </p>
      </div>
    );
  }
  const label = job.finished_at ? "Total " : "Robô ";
  return (
    <p>
      <span className="text-muted-foreground">{label}</span>
      {formatDuration(job.started_at, job.finished_at ?? nowIso)}
    </p>
  );
}

// no celular: cliente, status e ações; progresso, tempo e mensagem aparecem em telas maiores
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_32px] gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_120px_130px_32px] xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_130px_minmax(0,1.6fr)_32px]";

export function QueueTable({ initialJobs, role }: { initialJobs: AutomationJob[]; role: UserRole }) {
  const { jobs, connected } = useRealtimeJobs(initialJobs);
  const [tab, setTab] = useState<Tab>("active");
  const now = useNow();
  const visible = useMemo(() => jobs.filter((j) => matches(tab, j)), [jobs, tab]);
  const waitingSince = useWaitingSince(jobs);
  const manual = jobs.filter((j) => MANUAL_JOB_STATUSES.includes(j.status));
  const count = (t: Tab) => jobs.filter((j) => matches(t, j)).length;

  return (
    <div className="space-y-4">
      {manual.map((job) => (
        <div key={job.id} className="flex gap-3 rounded-xl border border-(--c-f6d5bd) bg-(--c-fdf3ea) px-4 py-3.5 text-(--c-7a3a0c)">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--c-d9630f)" />
          <div className="min-w-0 flex-1 space-y-1 text-[13px]">
            <p className="font-semibold">A automação está aguardando sua intervenção.</p>
            <p>
              <strong>{job.clients?.trade_name || job.clients?.legal_name}</strong> · {formatCompetence(job.competence)} —{" "}
              {job.manual_action_message ?? job.last_message}
            </p>
            <p className="text-xs opacity-80">Realize a ação no navegador aberto na máquina do robô e depois clique em continuar.</p>
            <div className="pt-1">
              <ContinueButton job={job} role={role} />
            </div>
          </div>
        </div>
      ))}

      <ListCard>
        <ListToolbar>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              ["active", "Em andamento", count("active")],
              ["waiting", "Aguardando SEFAZ", count("waiting")],
              ["manual", "Intervenção", count("manual")],
              ["finished", "Finalizados", count("finished")],
              ["all", "Todos", jobs.length],
            ]}
          />
          <span className="flex-1" />
          <span className={cn("flex items-center gap-1.5 text-xs", connected ? "text-(--c-1c7a47)" : "text-muted-foreground")}>
            <Radio className={cn("size-3.5", connected && "animate-pulse")} />
            {connected ? "Tempo real conectado" : "Conectando..."}
          </span>
        </ListToolbar>
        <ListHead grid={GRID}>
          <span>Cliente</span>
          <span>Status</span>
          <span className="hidden md:block">Progresso</span>
          <span className="hidden md:block">Tempo</span>
          <span className="hidden xl:block">Última mensagem</span>
          <span />
        </ListHead>
        {visible.length === 0 ? (
          <ListEmptyText>Nenhuma tarefa nesta visão.</ListEmptyText>
        ) : (
          visible.map((job) => {
            const step = JOB_STATUS_LABEL[job.current_step as AutomationJob["status"]] ?? job.current_step;
            const message = job.error_message && job.status === "failed" ? job.error_message : (job.last_message ?? "");
            return (
              <ListRow key={job.id} grid={GRID}>
                <PrimaryCell
                  title={job.clients?.trade_name || job.clients?.legal_name || "—"}
                  sub={
                    <>
                      <span className="font-mono">{job.clients?.client_code}</span> · {formatCompetence(job.competence)}
                    </>
                  }
                />
                <div className="flex min-w-0 flex-col items-start gap-0.5">
                  <JobStatusBadge status={job.status} />
                  {step && step !== JOB_STATUS_LABEL[job.status] ? (
                    <span className="max-w-full truncate text-[11px] text-(--c-7a7b75)">{step}</span>
                  ) : null}
                  {job.attempts > 1 ? <span className="text-[11px] text-(--c-7a7b75)">Tentativa {job.attempts}</span> : null}
                </div>
                <div className="hidden items-center gap-2 md:flex">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--c-f0f0ec)">
                    <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${job.progress}%` }} />
                  </div>
                  <span className="w-8 text-right font-mono text-[11px] text-(--c-7a7b75)">{job.progress}%</span>
                </div>
                <div className="hidden text-xs tabular-nums md:block">
                  <JobTime job={job} waitingSince={waitingSince[job.id]} now={now} />
                </div>
                <div className="hidden min-w-0 xl:block">
                  {message ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p
                          className={cn(
                            "line-clamp-2 cursor-default text-xs",
                            job.status === "failed" ? "text-(--c-b42323)" : "text-(--c-7a7b75)",
                          )}
                        >
                          {message}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm text-xs">{message}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-(--c-9a9b94)">—</span>
                  )}
                </div>
                <JobActions job={job} role={role} />
              </ListRow>
            );
          })
        )}
      </ListCard>
    </div>
  );
}
