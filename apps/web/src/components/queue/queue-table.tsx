"use client";

import { CirclePlay, Loader2, Radio, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { confirmManualAction, retryJob } from "@/app/actions/automation";
import { ListCard, ListEmptyText, ListHead, ListToolbar, SearchBox, Segmented } from "@/components/data-list";
import { PageHeader } from "@/components/page-header";
import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { PcWaitLine, useComputers } from "@/components/queue/pc-wait-notice";
import { JobStatusBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useNow } from "@/hooks/use-now";
import { useRealtimeJobs } from "@/hooks/use-realtime-jobs";
import { useWaitingSince } from "@/hooks/use-waiting-since";
import { formatCompetence } from "@/lib/competence";
import { formatClock } from "@/lib/format";
import { type Computer, pcWait, type PcWait } from "@/lib/pc-wait";
import { can } from "@/lib/permissions";
import {
  isManual,
  LATE_SEFAZ_MS,
  queueMatches,
  queuePositions,
  type QueueTab,
  SEFAZ_STATUSES,
  shortAgo,
  shortDuration,
  sortQueue,
} from "@/lib/queue-view";
import { ERROR_CODE_LABEL, FINAL_JOB_STATUSES, isJobRunning, JOB_STATUS_LABEL } from "@/lib/status";
import { zonedParts } from "@/lib/timezone";
import type { AutomationJob, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Título da coluna do meio em cada aba. */
const MIDDLE_HEAD: Record<QueueTab, string> = {
  active: "Posição",
  waiting: "Próx. consulta",
  manual: "Etapa",
  finished: "Arquivos",
  all: "Situação",
};

// no celular: cliente, status e ações; posição e tempo aparecem em telas maiores.
// Ações com 92px onde cabe o botão "Continuar" (abas Intervenção e Todos).
const GRID_MENU =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_32px] gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(150px,1.2fr)_92px_92px_32px]";
const GRID_CONTINUE =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,auto)_92px] gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(150px,1.2fr)_92px_92px_92px]";

function gridFor(tab: QueueTab): string {
  return tab === "manual" || tab === "all" ? GRID_CONTINUE : GRID_MENU;
}

function hhmm(value: string): string {
  const p = zonedParts(new Date(value));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function clientName(job: AutomationJob): string {
  return job.clients?.trade_name || job.clients?.legal_name || "—";
}

/** Linha curta embaixo do status (antes era a coluna "Última mensagem"). */
function StatusSub({ job, wait, now }: { job: AutomationJob; wait: PcWait | null; now: Date }) {
  if (wait) return <PcWaitLine job={job} wait={wait} now={now} />;
  const attempt = job.attempts > 1 ? `Tentativa ${job.attempts}` : "";
  let text = "";
  let tone = "text-(--c-6b6c66)";
  if (job.status === "failed") {
    text = [job.error_message || (job.error_code ? ERROR_CODE_LABEL[job.error_code] : "") || job.last_message, attempt]
      .filter(Boolean)
      .join(" · ");
    tone = "text-(--c-b42323)";
  } else if (isManual(job)) {
    text = job.manual_action_message || job.last_message || "";
    tone = "text-(--c-b4530f)";
  } else if (SEFAZ_STATUSES.includes(job.status)) {
    text = job.check_count > 0 ? `Consulta nº ${job.check_count}` : "";
  } else if (isJobRunning(job.status)) {
    const step = JOB_STATUS_LABEL[job.current_step as AutomationJob["status"]];
    text = [job.last_message || (step && step !== JOB_STATUS_LABEL[job.status] ? step : ""), attempt].filter(Boolean).join(" · ");
  } else if (job.status === "queued") {
    text = attempt;
  }
  if (!text) return null;
  return (
    <span className={cn("max-w-full truncate text-[11.5px]", tone)} title={text}>
      {text}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-(--c-f0f0ec)">
        <div className="h-full rounded-[3px] bg-primary transition-[width]" style={{ width: `${value}%` }} />
      </div>
      <span className="w-[30px] text-right font-mono text-[11px] text-(--c-6b6c66)">{value}%</span>
    </div>
  );
}

/** Coluna do meio: depende da situação do trabalho (e o título, da aba). */
function Middle({
  job,
  position,
  files,
}: {
  job: AutomationJob;
  position: number | undefined;
  files: number | null | undefined;
}) {
  const text = (value: string, className?: string) => (
    <span className={cn("text-xs whitespace-nowrap text-(--c-4a4b46)", className)}>{value}</span>
  );
  if (job.status === "queued") return text(position ? `${position}º na fila` : "na fila");
  if (SEFAZ_STATUSES.includes(job.status)) {
    if (job.status !== "waiting_sefaz") return <ProgressBar value={job.progress} />;
    return text(job.next_check_at ? hhmm(job.next_check_at) : "—", "font-mono");
  }
  if (isManual(job)) {
    return text(JOB_STATUS_LABEL[job.current_step as AutomationJob["status"]] ?? "—", "truncate");
  }
  if (isJobRunning(job.status)) return <ProgressBar value={job.progress} />;
  // finalizado: arquivos baixados (consultas de EFD e malhas não baixam arquivo)
  const exports = job.operations.some((o) => o !== "EFD_CHECK" && o !== "MALHA_CHECK");
  if (!exports || files === null) return text("—", "text-(--c-6b6c66)");
  if (!files) return text("nenhum", "text-(--c-6b6c66)");
  return text(`${files} ZIP${files === 1 ? "" : "s"}`);
}

/** Tempo, um valor só: cronômetro, espera da SEFAZ, espera por você ou duração. */
function Time({ job, waitingSince, now }: { job: AutomationJob; waitingSince?: string; now: number | null }) {
  if (now === null) return null;
  if (job.status === "queued") return <span className="text-xs text-(--c-6b6c66)">—</span>;
  if (isManual(job)) {
    const since = job.manual_action_requested_at ?? job.updated_at;
    return <span className="text-xs whitespace-nowrap text-(--c-b4530f)">{shortAgo(now - Date.parse(since))}</span>;
  }
  if (SEFAZ_STATUSES.includes(job.status)) {
    const ms = now - Date.parse(waitingSince ?? job.updated_at);
    const late = ms > LATE_SEFAZ_MS;
    return (
      <span
        className={cn(
          "inline-block rounded-[5px] text-xs whitespace-nowrap",
          late ? "bg-(--c-fdf4e3) px-[7px] py-0.5 font-semibold text-(--c-9a6205)" : "text-foreground",
        )}
      >
        {shortAgo(ms)}
      </span>
    );
  }
  if (FINAL_JOB_STATUSES.includes(job.status)) {
    if (!job.started_at || !job.finished_at) return <span className="text-xs text-(--c-6b6c66)">—</span>;
    return (
      <span className="text-xs whitespace-nowrap">
        {shortDuration((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000)}
      </span>
    );
  }
  if (!job.started_at) return <span className="text-xs text-(--c-6b6c66)">—</span>;
  return <span className="font-mono text-xs">{formatClock((now - Date.parse(job.started_at)) / 1000)}</span>;
}

/** Ação em lote da aba: continuar todas as intervenções ou reprocessar os erros. */
function BulkAction({ tab, jobs, role }: { tab: QueueTab; jobs: AutomationJob[]; role: UserRole }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const router = useRouter();

  const toContinue = jobs.filter(
    (j) =>
      (j.status === "manual_action_required" || j.status === "waiting_certificate") &&
      !(j.manual_action_confirmed_at && j.manual_action_requested_at && j.manual_action_confirmed_at >= j.manual_action_requested_at),
  );
  const failed = jobs.filter((j) => j.status === "failed");

  function runAll(ids: string[], fn: (id: string) => Promise<{ ok: boolean; error?: string }>, done: string) {
    start(async () => {
      let ok = 0;
      let lastError = "";
      for (const id of ids) {
        const res = await fn(id);
        if (res.ok) ok += 1;
        else lastError = res.error ?? "";
      }
      if (ok > 0) toast.success(`${ok} ${done}`);
      if (ok < ids.length) toast.error(lastError || "Alguns trabalhos não puderam ser alterados.");
      router.refresh();
    });
  }

  if (tab === "manual" && toContinue.length > 0 && can(role, "automation:run")) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => runAll(toContinue.map((j) => j.id), confirmManualAction, "trabalho(s) liberado(s) para continuar.")}
        className="flex h-8 items-center gap-1.5 rounded-[7px] border border-(--c-f97316) bg-(--c-f97316) px-3 text-[12.5px] font-medium whitespace-nowrap text-white hover:bg-[#ea580c] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CirclePlay className="size-3.5" />}
        Continuar todos
      </button>
    );
  }
  if (tab === "finished" && failed.length > 0 && can(role, "automation:retry")) {
    return (
      <>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirm(true)}
          className="flex h-8 items-center gap-1.5 rounded-[7px] border border-(--c-f0c9c9) bg-card px-3 text-[12.5px] font-medium whitespace-nowrap text-(--c-b42323) hover:bg-(--c-fdecec) disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          Reprocessar erros
        </button>
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reprocessar {failed.length} trabalho(s) com erro?</AlertDialogTitle>
              <AlertDialogDescription>
                Eles voltam para a fila e o robô tenta de novo, na ordem. Os que já foram agendados no SIAT não são
                pedidos outra vez.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Voltar</AlertDialogCancel>
              <AlertDialogAction onClick={() => runAll(failed.map((j) => j.id), retryJob, "trabalho(s) devolvido(s) à fila.")}>
                Reprocessar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
  return null;
}

export function QueueTable({
  initialJobs,
  role,
  computers: initialComputers = [],
  serverNow,
  initialTab = "active",
  files = {},
  filesSince,
  liveComputers = true,
}: {
  initialJobs: AutomationJob[];
  role: UserRole;
  /** computadores do escritório e se estão ligados (para "aguardando o PC X") */
  computers?: Computer[];
  /** hora do servidor, para o primeiro desenho do "há 29 min" */
  serverNow?: string;
  initialTab?: QueueTab;
  /** arquivos baixados por trabalho (só os que têm algum) */
  files?: Record<string, number>;
  /** a contagem de arquivos vale para trabalhos finalizados até esta hora */
  filesSince?: string;
  liveComputers?: boolean;
}) {
  const { jobs, connected } = useRealtimeJobs(initialJobs);
  const [tab, setTab] = useState<QueueTab>(initialTab);
  const [q, setQ] = useState("");
  const now = useNow();
  const waitingSince = useWaitingSince(jobs);
  const computers = useComputers(initialComputers, liveComputers);
  const clock = new Date(now ?? (serverNow ? Date.parse(serverNow) : 0));
  const waits = useMemo(() => new Map(jobs.map((j) => [j.id, pcWait(j, computers)])), [jobs, computers]);
  const positions = useMemo(() => queuePositions(jobs), [jobs]);
  const count = (t: QueueTab) => jobs.filter((j) => queueMatches(t, j)).length;

  const term = q.trim().toLowerCase();
  const inTab = useMemo(() => jobs.filter((j) => queueMatches(tab, j)), [jobs, tab]);
  const visible = useMemo(
    () =>
      sortQueue(
        inTab.filter(
          (j) =>
            !term ||
            clientName(j).toLowerCase().includes(term) ||
            (j.clients?.client_code ?? "").toLowerCase().includes(term),
        ),
        waitingSince,
      ),
    [inTab, term, waitingSince],
  );
  const grid = gridFor(tab);
  const filesOf = (job: AutomationJob): number | null => {
    if (files[job.id] !== undefined) return files[job.id];
    // finalizado depois de a página abrir: a contagem ainda não veio do servidor
    if (filesSince && job.finished_at && job.finished_at > filesSince) return null;
    return 0;
  };

  return (
    <>
      <PageHeader
        title="Fila de processamento"
        description="Cada cliente sendo processado pelo robô, em tempo real."
        actions={
          <span className={cn("flex items-center gap-1.5 text-xs", connected ? "text-(--c-1c7a47)" : "text-muted-foreground")}>
            <Radio className="size-3.5" />
            {connected ? "Tempo real conectado" : "Conectando..."}
          </span>
        }
      />
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
          <BulkAction tab={tab} jobs={inTab} role={role} />
          <div className="flex min-w-[200px] sm:max-w-[240px]">
            <SearchBox value={q} onChange={setQ} placeholder="Filtrar cliente" />
          </div>
        </ListToolbar>
        <ListHead grid={grid}>
          <span>Cliente</span>
          <span>Status</span>
          <span className="hidden md:block">{MIDDLE_HEAD[tab]}</span>
          <span className="hidden md:block">Tempo</span>
          <span />
        </ListHead>
        {visible.length === 0 ? (
          <ListEmptyText>{term ? "Nenhum cliente encontrado nesta visão." : "Nenhuma tarefa nesta visão."}</ListEmptyText>
        ) : (
          visible.map((job) => {
            const running = isJobRunning(job.status) && !SEFAZ_STATUSES.includes(job.status) && !isManual(job);
            return (
              <div
                key={job.id}
                className={cn(
                  grid,
                  "items-center border-b border-(--c-f2f2ef) px-4 py-[11px] text-[13px] last:border-b-0 hover:bg-(--c-fafaf8)",
                  running && "bg-(--c-f5f9ff)",
                )}
              >
                <div className="flex min-w-0 flex-col gap-px">
                  <Link
                    href={`/history/${job.id}`}
                    className="truncate font-medium text-foreground hover:text-primary hover:underline"
                    title={clientName(job)}
                  >
                    {clientName(job)}
                  </Link>
                  <span className="truncate text-[11.5px] whitespace-nowrap text-(--c-6b6c66)">
                    <span className="font-mono">{job.clients?.client_code}</span> · {formatCompetence(job.competence)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-[3px]">
                  <JobStatusBadge status={job.status} />
                  <StatusSub job={job} wait={waits.get(job.id) ?? null} now={clock} />
                </div>
                <div className="hidden min-w-0 md:block">
                  <Middle job={job} position={positions.get(job.id)} files={filesOf(job)} />
                </div>
                <div className="hidden text-xs tabular-nums md:block">
                  <Time job={job} waitingSince={waitingSince[job.id]} now={now} />
                </div>
                <div className="flex justify-end">
                  {isManual(job) && job.status !== "certificate_required" ? (
                    <ContinueButton job={job} role={role} compact />
                  ) : (
                    <JobActions job={job} role={role} />
                  )}
                </div>
              </div>
            );
          })
        )}
        {visible.length > 0 ? (
          <p className="border-t border-(--c-efefeb) px-4 py-2.5 text-center text-xs text-(--c-6b6c66)">
            {visible.length === 1 ? "1 item." : `Todos os ${visible.length} estão na lista.`}
          </p>
        ) : null}
      </ListCard>
    </>
  );
}
