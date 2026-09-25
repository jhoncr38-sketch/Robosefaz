import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { JobActions } from "@/components/queue/job-actions";
import { EmptyState, PageHeader } from "@/components/page-header";
import { JobStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSession } from "@/lib/auth";
import { formatCompetence } from "@/lib/competence";
import { formatDateTime } from "@/lib/format";
import { JOB_SELECT } from "@/lib/queries";
import { ERROR_CODE_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, AutomationLog } from "@/lib/types";

export const metadata: Metadata = { title: "Erros" };

export default async function ErrorsPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [jobsRes, logsRes] = await Promise.all([
    supabase
      .from("automation_jobs")
      .select(JOB_SELECT)
      .or("status.in.(failed,certificate_required),error_code.not.is.null")
      .order("updated_at", { ascending: false })
      .limit(200),
    supabase
      .from("automation_logs")
      .select("*, automation_jobs(competence, clients(legal_name, trade_name))")
      .eq("level", "ERROR")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const jobs = (jobsRes.data ?? []) as AutomationJob[];
  const logs = (logsRes.data ?? []) as (AutomationLog & {
    automation_jobs: { competence: string; clients: { legal_name: string; trade_name: string | null } | null } | null;
  })[];

  return (
    <>
      <PageHeader title="Erros" description="Falhas de automação, códigos de erro e screenshots capturados." />
      <Card className="mb-6 gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">Jobs com erro</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <EmptyState icon={<AlertTriangle />} title="Nenhum erro registrado" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Cliente</TableHead>
                    <TableHead>Competência</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Código</TableHead>
                    <TableHead>Mensagem</TableHead>
                    <TableHead>Screenshot</TableHead>
                    <TableHead>Quando</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="pl-4">
                        <Link href={`/history/${j.id}`} className="font-medium hover:underline">
                          {j.clients?.trade_name || j.clients?.legal_name}
                        </Link>
                      </TableCell>
                      <TableCell>{formatCompetence(j.competence)}</TableCell>
                      <TableCell>
                        <JobStatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-mono">{j.error_code ?? "—"}</span>
                        {j.error_code ? <p className="text-muted-foreground">{ERROR_CODE_LABEL[j.error_code]}</p> : null}
                      </TableCell>
                      <TableCell className="max-w-80 truncate text-xs" title={j.error_message ?? ""}>
                        {j.error_message ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-[11px] text-muted-foreground" title={j.error_screenshot_path ?? ""}>
                        {j.error_screenshot_path ? j.error_screenshot_path.split(/[\\/]/).pop() : "—"}
                      </TableCell>
                      <TableCell className="text-xs">{formatDateTime(j.updated_at)}</TableCell>
                      <TableCell>
                        <JobActions job={j} role={profile.role} />
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
          <CardTitle className="text-base">Últimos logs de erro</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <EmptyState title="Sem logs de erro" />
          ) : (
            <ul className="divide-y text-sm">
              {logs.map((l) => (
                <li key={l.id} className="grid gap-1 px-4 py-2.5 md:grid-cols-[150px_220px_1fr]">
                  <span className="text-xs text-muted-foreground">{formatDateTime(l.created_at)}</span>
                  <span className="truncate text-xs">
                    {l.job_id ? (
                      <Link href={`/history/${l.job_id}`} className="hover:underline">
                        {l.automation_jobs?.clients?.trade_name || l.automation_jobs?.clients?.legal_name || "Job"} ·{" "}
                        {formatCompetence(l.automation_jobs?.competence)}
                      </Link>
                    ) : (
                      "Sistema"
                    )}
                  </span>
                  <span className="font-mono text-xs text-red-700">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
