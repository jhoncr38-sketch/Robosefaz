"use client";

import { AlertTriangle, Radio } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { JobStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
function JobTime({ job, waitingSince, now }: { job: AutomationJob; waitingSince?: string; now: number }) {
  if (!job.started_at) return <span className="text-muted-foreground">—</span>;
  const nowIso = new Date(now).toISOString();
  if (SEFAZ_PHASE.includes(job.status) && waitingSince) {
    return (
      <div className="space-y-0.5 leading-tight">
        <p>
          <span className="text-muted-foreground">Robô </span>
          {formatDuration(job.started_at, waitingSince)}
        </p>
        <p className="text-amber-700">
          <span className="text-amber-700/70">SEFAZ há </span>
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

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function QueueTable({ initialJobs, role }: { initialJobs: AutomationJob[]; role: UserRole }) {
  const { jobs, connected } = useRealtimeJobs(initialJobs);
  const [tab, setTab] = useState<Tab>("active");
  const now = useNow();
  const visible = useMemo(() => jobs.filter((j) => matches(tab, j)), [jobs, tab]);
  const waitingSince = useWaitingSince(jobs);
  const manual = jobs.filter((j) => MANUAL_JOB_STATUSES.includes(j.status));
  const counts = useMemo(
    () => ({
      active: jobs.filter((j) => matches("active", j)).length,
      waiting: jobs.filter((j) => matches("waiting", j)).length,
      manual: jobs.filter((j) => matches("manual", j)).length,
      finished: jobs.filter((j) => matches("finished", j)).length,
      all: jobs.length,
    }),
    [jobs],
  );

  return (
    <div className="space-y-4">
      {manual.map((job) => (
        <Alert key={job.id} className="border-orange-200 bg-orange-50 text-orange-900">
          <AlertTriangle className="text-orange-600" />
          <AlertTitle>A automação está aguardando sua intervenção.</AlertTitle>
          <AlertDescription className="text-orange-900/90">
            <p>
              <strong>{job.clients?.trade_name || job.clients?.legal_name}</strong> · {formatCompetence(job.competence)} —{" "}
              {job.manual_action_message ?? job.last_message}
            </p>
            <p className="text-xs">Realize a ação no navegador aberto na máquina do robô e depois clique em continuar.</p>
            <div className="mt-2">
              <ContinueButton job={job} role={role} />
            </div>
          </AlertDescription>
        </Alert>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="active">Em andamento ({counts.active})</TabsTrigger>
            <TabsTrigger value="waiting">Aguardando SEFAZ ({counts.waiting})</TabsTrigger>
            <TabsTrigger value="manual">Intervenção ({counts.manual})</TabsTrigger>
            <TabsTrigger value="finished">Finalizados ({counts.finished})</TabsTrigger>
            <TabsTrigger value="all">Todos ({counts.all})</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className={cn("flex items-center gap-1.5 text-xs", connected ? "text-emerald-700" : "text-muted-foreground")}>
          <Radio className={cn("size-3.5", connected && "animate-pulse")} />
          {connected ? "Tempo real conectado" : "Conectando..."}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-40">Progresso</TableHead>
              <TableHead>Tempo</TableHead>
              <TableHead className="hidden xl:table-cell">Última mensagem</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                  Nenhuma tarefa nesta visão.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((job) => {
                const step = JOB_STATUS_LABEL[job.current_step as AutomationJob["status"]] ?? job.current_step;
                const message =
                  job.error_message && job.status === "failed" ? job.error_message : (job.last_message ?? "");
                return (
                  <TableRow key={job.id}>
                    <TableCell className="max-w-56">
                      <p className="truncate font-medium">{job.clients?.trade_name || job.clients?.legal_name || "—"}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {job.clients?.client_code} · {formatCompetence(job.competence)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                      {step && step !== JOB_STATUS_LABEL[job.status] ? (
                        <p className="mt-1 text-xs text-muted-foreground">{step}</p>
                      ) : null}
                      {job.attempts > 1 ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">Tentativa {job.attempts}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Progress value={job.progress} className="h-1.5" />
                        <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{job.progress}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums whitespace-nowrap">
                      <JobTime job={job} waitingSince={waitingSince[job.id]} now={now} />
                    </TableCell>
                    <TableCell className="hidden max-w-64 xl:table-cell">
                      {message ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p
                              className={cn(
                                "line-clamp-2 cursor-default text-xs",
                                job.status === "failed" ? "text-red-600" : "text-muted-foreground",
                              )}
                            >
                              {message}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm text-xs">{message}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <JobActions job={job} role={role} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
