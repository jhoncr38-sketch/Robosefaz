import { ArrowLeft, ImageIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DownloadsTable } from "@/components/downloads-table";
import { JobLogs } from "@/components/job-logs";
import { ContinueButton, JobActions } from "@/components/queue/job-actions";
import { JobStatusBadge, TaskStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSession } from "@/lib/auth";
import { formatCNPJ } from "@/lib/cnpj";
import { formatCompetence } from "@/lib/competence";
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

export default async function JobDetailPage({ params }: PageProps<"/history/[id]">) {
  const { id } = await params;
  const { profile } = await requireSession();
  const supabase = await createClient();
  const { data: jobData } = await supabase.from("automation_jobs").select(JOB_SELECT).eq("id", id).maybeSingle();
  if (!jobData) notFound();
  const job = jobData as AutomationJob;

  const [tasksRes, logsRes, downloadsRes, users] = await Promise.all([
    supabase.from("automation_tasks").select("*").eq("job_id", id).order("created_at"),
    supabase.from("automation_logs").select("*").eq("job_id", id).order("created_at").limit(2000),
    supabase.from("downloads").select("*").eq("job_id", id),
    loadProfilesMap(),
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Protocolo / ID externo</TableHead>
                <TableHead>Solicitado</TableHead>
                <TableHead>Finalizado</TableHead>
                <TableHead>Retentativas</TableHead>
                <TableHead className="pr-4">Mensagem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id} className={t.superseded ? "opacity-50" : undefined}>
                  <TableCell className="pl-4 font-medium">
                    {TASK_TYPE_LABEL[t.task_type]}
                    {t.superseded ? <span className="ml-1 text-xs text-muted-foreground">(substituída)</span> : null}
                  </TableCell>
                  <TableCell>
                    <TaskStatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.external_request_id ?? "—"}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(t.requested_at ?? t.started_at)}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(t.finished_at)}</TableCell>
                  <TableCell className="text-center">{t.retry_count}</TableCell>
                  <TableCell className="max-w-80 truncate pr-4 text-xs text-muted-foreground" title={t.error_message ?? ""}>
                    {t.error_message ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {downloads.length > 0 ? (
        <Card className="mb-6 gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Arquivos baixados</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DownloadsTable rows={downloads} showClient={false} />
          </CardContent>
        </Card>
      ) : null}

      <JobLogs jobId={job.id} initialLogs={logs} />
    </>
  );
}
