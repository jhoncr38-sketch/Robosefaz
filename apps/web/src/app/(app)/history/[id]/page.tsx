import { ArrowLeft, ImageIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { DownloadsTable } from "@/components/downloads-table";
import { JobLogs } from "@/components/job-logs";
import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { Button } from "@/components/ui/button";
import { JobStatusBadge, TaskStatusBadge, ToneBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { requireSession } from "@/lib/auth";
import { formatCNPJ } from "@/lib/cnpj";
import { formatCompetence } from "@/lib/competence";
import { notesInGoogleDrive } from "@/lib/downloads";
import { formatDate, formatDateTime, formatDuration } from "@/lib/format";
import { JOB_SELECT, loadProfilesMap } from "@/lib/queries";
import { ERROR_CODE_LABEL, MANUAL_JOB_STATUSES, TASK_TYPE_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, AutomationLog, AutomationTask, DownloadRow } from "@/lib/types";

export const metadata: Metadata = { title: "Detalhes da execução" };

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

// sem rolagem lateral: no celular, tipo e status; datas, protocolo e mensagem em telas maiores
const TASK_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_160px_110px_120px] xl:grid-cols-[minmax(0,1fr)_160px_110px_120px_120px_56px_minmax(0,1.4fr)]";

export default async function JobDetailPage({ params }: PageProps<"/history/[id]">) {
  const { id } = await params;
  const { profile } = await requireSession();
  const supabase = await createClient();
  const { data: jobData } = await supabase.from("automation_jobs").select(JOB_SELECT).eq("id", id).maybeSingle();
  if (!jobData) notFound();
  const job = jobData as AutomationJob;

  const [tasksRes, logsRes, downloadsRes, users, drive] = await Promise.all([
    supabase.from("automation_tasks").select("*").eq("job_id", id).order("created_at"),
    supabase.from("automation_logs").select("*").eq("job_id", id).order("created_at").limit(2000),
    supabase.from("downloads").select("*").eq("job_id", id),
    loadProfilesMap(),
    notesInGoogleDrive(supabase),
  ]);
  const tasks = (tasksRes.data ?? []) as AutomationTask[];
  const logs = (logsRes.data ?? []) as AutomationLog[];
  const downloads = (downloadsRes.data ?? []) as DownloadRow[];

  return (
    <>
      <Link href="/history" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Histórico
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {job.clients?.trade_name || job.clients?.legal_name} · {formatCompetence(job.competence)}
            </h1>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <Link href={`/clients/${job.client_id}`} className="hover:underline">
              {job.clients?.client_code}
            </Link>{" "}
            · <span className="font-mono">{formatCNPJ(job.clients?.cnpj)}</span> · Job {job.id.slice(0, 8)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {job.operations.includes("EFD_CHECK") ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/efd?competence=${job.competence}`} className="text-foreground hover:no-underline">
                Ver resultado da EFD
              </Link>
            </Button>
          ) : null}
          <ContinueButton job={job} role={profile.role} />
          <JobActions job={job} role={profile.role} />
        </div>
      </div>

      {MANUAL_JOB_STATUSES.includes(job.status) ? (
        <Alert className="mb-4 border-orange-200 bg-orange-50 text-orange-900">
          <AlertTitle>A automação está aguardando sua intervenção.</AlertTitle>
          <AlertDescription className="text-orange-900">{job.manual_action_message ?? job.last_message}</AlertDescription>
        </Alert>
      ) : null}

      {job.error_code ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>{ERROR_CODE_LABEL[job.error_code] ?? job.error_code}</AlertTitle>
          <AlertDescription>
            {job.error_message}
            {job.error_screenshot_path ? (
              <span className="mt-1 flex items-center gap-1 text-xs">
                <ImageIcon className="size-3.5" /> Screenshot: <span className="font-mono">{job.error_screenshot_path}</span>
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-6">
        <CardContent className="space-y-5">
          <div className="flex items-center gap-3">
            <Progress value={job.progress} className="h-2" />
            <span className="w-10 text-right text-sm tabular-nums">{job.progress}%</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-3 lg:grid-cols-6">
            <Info label="Período">
              {formatDate(job.start_date)} a {formatDate(job.end_date)}
            </Info>
            <Info label="Solicitado por">{job.created_by ? users[job.created_by] ?? "—" : "Sistema"}</Info>
            <Info label="Criado em">{formatDateTime(job.created_at)}</Info>
            <Info label="Iniciado">{formatDateTime(job.started_at)}</Info>
            <Info label="Finalizado">{formatDateTime(job.finished_at)}</Info>
            <Info label="Duração">{formatDuration(job.started_at, job.finished_at ?? job.updated_at)}</Info>
            <Info label="Tentativas">
              {job.attempts} (máx. {job.max_attempts} retentativas)
            </Info>
            <Info label="Consultas à SEFAZ">{job.check_count}</Info>
            <Info label="Próxima consulta">{formatDateTime(job.next_check_at)}</Info>
            <Info label="Forçado">{job.force_reschedule ? "Sim" : "Não"}</Info>
            <Info label="Worker">{job.locked_by ?? "—"}</Info>
            <Info label="Última mensagem">{job.last_message ?? "—"}</Info>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6 gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">Tarefas</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ListHead grid={TASK_GRID}>
            <span>Tipo</span>
            <span className="text-right md:text-left">Status</span>
            <span className="hidden md:block">Protocolo</span>
            <span className="hidden md:block">Solicitado</span>
            <span className="hidden xl:block">Finalizado</span>
            <span className="hidden text-center xl:block">Retent.</span>
            <span className="hidden xl:block">Mensagem</span>
          </ListHead>
          {tasks.map((t) => (
            <ListRow key={t.id} grid={TASK_GRID} className={t.superseded ? "opacity-50" : undefined}>
              <PrimaryCell
                title={
                  <>
                    {TASK_TYPE_LABEL[t.task_type]}
                    {t.superseded ? <span className="ml-1 text-xs font-normal text-(--c-7a7b75)">(substituída)</span> : null}
                  </>
                }
                sub={
                  <span className="md:hidden">
                    {t.external_request_id ? `ID ${t.external_request_id} · ` : ""}
                    {formatDateTime(t.requested_at ?? t.started_at)}
                  </span>
                }
              />
              <div className="flex justify-end md:justify-start">
                {t.result?.no_notes ? (
                  <ToneBadge tone="gray">Sem notas no período</ToneBadge>
                ) : (
                  <TaskStatusBadge status={t.status} />
                )}
              </div>
              <span className="hidden font-mono text-xs md:block">{t.external_request_id ?? "—"}</span>
              <span className="hidden text-xs tabular-nums md:block">{formatDateTime(t.requested_at ?? t.started_at)}</span>
              <span className="hidden text-xs tabular-nums xl:block">{formatDateTime(t.finished_at)}</span>
              <span className="hidden text-center font-mono text-xs xl:block">{t.retry_count}</span>
              <span className="hidden truncate text-xs text-(--c-7a7b75) xl:block" title={t.error_message ?? ""}>
                {t.error_message ?? "—"}
              </span>
            </ListRow>
          ))}
        </CardContent>
      </Card>

      {downloads.length > 0 ? (
        <Card className="mb-6 gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Arquivos baixados</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DownloadsTable rows={downloads} showClient={false} drive={drive} />
          </CardContent>
        </Card>
      ) : null}

      <JobLogs jobId={job.id} initialLogs={logs} />
    </>
  );
}
