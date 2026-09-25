"use client";

import { AlertTriangle, Radio } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { JobStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtimeJobs } from "@/hooks/use-realtime-jobs";
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
              <TableHead>Competência</TableHead>
              <TableHead>Etapa</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-44">Progresso</TableHead>
              <TableHead>Tempo</TableHead>
              <TableHead className="text-center">Tentativas</TableHead>
              <TableHead>Última mensagem</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center text-sm text-muted-foreground">
                  Nenhuma tarefa nesta visão.
                </TableCell>
              </TableRow>
            ) : (
              visible.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <p className="font-medium">{job.clients?.trade_name || job.clients?.legal_name || "—"}</p>
                    <p className="text-xs text-muted-foreground">{job.clients?.client_code}</p>
                  </TableCell>
                  <TableCell>{formatCompetence(job.competence)}</TableCell>
                  <TableCell className="text-sm">{JOB_STATUS_LABEL[job.current_step as AutomationJob["status"]] ?? job.current_step ?? "—"}</TableCell>
                  <TableCell>
                    <JobStatusBadge status={job.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Progress value={job.progress} className="h-1.5" />
                      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{job.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {job.started_at
                      ? formatDuration(job.started_at, job.finished_at ?? new Date(now).toISOString())
                      : "—"}
                  </TableCell>
                  <TableCell className="text-center text-sm tabular-nums">{job.attempts}</TableCell>
                  <TableCell className="max-w-72 truncate text-xs text-muted-foreground" title={job.last_message ?? ""}>
                    {job.error_message && job.status === "failed" ? (
                      <span className="text-red-600">{job.error_message}</span>
                    ) : (
                      job.last_message ?? "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <JobActions job={job} role={role} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
