import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  Download,
  Hourglass,
  Loader,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ProcessCompetenceDialog } from "@/components/automation/process-competence-dialog";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { CertificateStatusBadge, JobStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSession } from "@/lib/auth";
import { formatCompetence } from "@/lib/competence";
import { daysUntil, formatDateTime, isoDaysFromNow } from "@/lib/format";
import { can } from "@/lib/permissions";
import { JOB_SELECT, loadPlannerClients } from "@/lib/queries";
import { certificateStatusFromDate, TASK_TYPE_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, DashboardStats } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard" };

function resultOf(job: AutomationJob): string {
  if (job.status === "completed") return job.last_message ?? "Concluído";
  if (job.status === "failed") return job.error_message ?? "Erro";
  return job.last_message ?? "—";
}

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const { profile } = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  const [statsRes, jobsRes, certsRes, plannerClients] = await Promise.all([
    supabase.rpc("dashboard_stats"),
    supabase.from("automation_jobs").select(JOB_SELECT).order("created_at", { ascending: false }).limit(10),
    supabase
      .from("certificates")
      .select("id, client_id, valid_until, subject_name, clients(legal_name, trade_name, client_code)")
      .eq("active", true)
      .lte("valid_until", isoDaysFromNow(30))
      .order("valid_until")
      .limit(8),
    can(profile.role, "automation:run") ? loadPlannerClients() : Promise.resolve([]),
  ]);

  const stats = (statsRes.data ?? {}) as Partial<DashboardStats>;
  const jobs = (jobsRes.data ?? []) as AutomationJob[];
  const expiring = (certsRes.data ?? []) as unknown as {
    id: string;
    client_id: string;
    valid_until: string;
    clients: { legal_name: string; trade_name: string | null; client_code: string } | null;
  }[];
  const n = (v?: number) => v ?? 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Visão geral das automações do SIAT Web."
        actions={
          can(profile.role, "automation:run") ? (
            <ProcessCompetenceDialog clients={plannerClients} canForce={can(profile.role, "automation:force")} />
          ) : null
        }
      />

      {params.error === "forbidden" ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>Você não tem permissão para acessar aquela página.</AlertDescription>
        </Alert>
      ) : null}

      {n(stats.jobs_manual) > 0 ? (
        <Alert className="mb-4 border-orange-200 bg-orange-50 text-orange-900">
          <AlertTriangle className="text-orange-600" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-orange-900">
            {n(stats.jobs_manual)} automação(ões) aguardando sua intervenção.
            <Button asChild size="sm" variant="outline">
              <Link href="/queue">Abrir fila</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Clientes ativos" value={n(stats.clients_active)} icon={<Building2 />} href="/clients" />
        <StatCard label="Certificados válidos" value={n(stats.certificates_valid)} icon={<ShieldCheck />} accent="green" href="/certificates" />
        <StatCard label="Vencendo em 30 dias" value={n(stats.certificates_expiring)} icon={<ShieldAlert />} accent="yellow" href="/certificates" />
        <StatCard label="Certificados vencidos" value={n(stats.certificates_expired)} icon={<ShieldX />} accent="red" href="/certificates" />
        <StatCard label="Processamentos hoje" value={n(stats.jobs_today)} icon={<CalendarClock />} accent="blue" href="/history" />
        <StatCard label="Processando" value={n(stats.jobs_processing)} icon={<Loader />} accent="blue" hint={`${n(stats.jobs_queued)} na fila`} href="/queue" />
        <StatCard label="Aguardando SEFAZ" value={n(stats.jobs_waiting_sefaz)} icon={<Hourglass />} accent="yellow" href="/queue" />
        <StatCard label="Downloads disponíveis" value={n(stats.downloads_available)} icon={<Download />} accent="green" href="/downloads" />
        <StatCard label="Concluídos" value={n(stats.jobs_completed)} icon={<CheckCircle2 />} accent="green" href="/history" />
        <StatCard label="Erros" value={n(stats.jobs_failed)} icon={<AlertTriangle />} accent="red" href="/errors" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between border-b py-4">
            <CardTitle className="text-base">Últimas execuções</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/history">Ver histórico</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {jobs.length === 0 ? (
              <EmptyState title="Nenhuma execução ainda" description="Use “Processar competência” para criar as primeiras tarefas." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Cliente</TableHead>
                      <TableHead>Competência</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Iniciado</TableHead>
                      <TableHead>Finalizado</TableHead>
                      <TableHead className="pr-4">Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((job) => (
                      <TableRow key={job.id}>
                        <TableCell className="pl-4">
                          <Link href={`/history/${job.id}`} className="font-medium hover:underline">
                            {job.clients?.trade_name || job.clients?.legal_name}
                          </Link>
                        </TableCell>
                        <TableCell>{formatCompetence(job.competence)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {job.operations.map((o) => TASK_TYPE_LABEL[o]).join(", ")}
                        </TableCell>
                        <TableCell>
                          <JobStatusBadge status={job.status} />
                        </TableCell>
                        <TableCell className="text-xs">{formatDateTime(job.started_at)}</TableCell>
                        <TableCell className="text-xs">{formatDateTime(job.finished_at)}</TableCell>
                        <TableCell className="max-w-64 truncate pr-4 text-xs text-muted-foreground" title={resultOf(job)}>
                          {resultOf(job)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-base">Certificados vencendo em 30 dias</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {expiring.length === 0 ? (
              <EmptyState icon={<ShieldCheck />} title="Nenhum certificado vencendo" />
            ) : (
              <ul className="divide-y">
                {expiring.map((c) => {
                  const days = daysUntil(c.valid_until) ?? 0;
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <Link href={`/clients/${c.client_id}`} className="block truncate text-sm font-medium hover:underline">
                          {c.clients?.trade_name || c.clients?.legal_name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {days > 0 ? `Vence em ${days} dia(s)` : "Vencido"}
                        </p>
                      </div>
                      <CertificateStatusBadge status={certificateStatusFromDate(c.valid_until)} />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
