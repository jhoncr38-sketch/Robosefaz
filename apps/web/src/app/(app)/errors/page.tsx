import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ListCard, ListEmptyText, ListHead, ListRow, ListTitle, PrimaryCell } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { JobActions } from "@/components/queue/job-actions";
import { JobStatusBadge } from "@/components/status-badge";
import { requireSession } from "@/lib/auth";
import { formatCompetence } from "@/lib/competence";
import { formatDateTime } from "@/lib/format";
import { JOB_SELECT } from "@/lib/queries";
import { ERROR_CODE_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, AutomationLog } from "@/lib/types";

export const metadata: Metadata = { title: "Erros" };

// sem rolagem lateral: no celular, cliente, status e ações; código e mensagem em telas maiores
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_32px] gap-3 md:grid-cols-[minmax(0,1.2fr)_150px_minmax(0,1fr)_110px_32px] xl:grid-cols-[minmax(0,1.1fr)_150px_minmax(0,1fr)_minmax(0,1.8fr)_110px_32px]";
const LOG_GRID = "grid grid-cols-1 gap-1 md:grid-cols-[120px_minmax(0,220px)_minmax(0,1fr)] md:gap-3";

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
      <ListCard className="mb-5">
        <ListTitle title="Jobs com erro" count={jobs.length} />
        {jobs.length === 0 ? (
          <EmptyState icon={<AlertTriangle />} title="Nenhum erro registrado" />
        ) : (
          <>
            <ListHead grid={GRID}>
              <span>Cliente</span>
              <span>Status</span>
              <span className="hidden md:block">Código</span>
              <span className="hidden xl:block">Mensagem</span>
              <span className="hidden md:block">Quando</span>
              <span />
            </ListHead>
            {jobs.map((j) => {
              const shot = j.error_screenshot_path ? j.error_screenshot_path.split(/[\\/]/).pop() : null;
              return (
                <ListRow key={j.id} grid={GRID}>
                  <PrimaryCell
                    title={
                      <Link href={`/history/${j.id}`} className="text-foreground hover:underline">
                        {j.clients?.trade_name || j.clients?.legal_name}
                      </Link>
                    }
                    sub={
                      <>
                        {formatCompetence(j.competence)}
                        <span className="md:hidden"> · {formatDateTime(j.updated_at)}</span>
                      </>
                    }
                  />
                  <div>
                    <JobStatusBadge status={j.status} />
                  </div>
                  <div className="hidden min-w-0 flex-col gap-px md:flex">
                    <span className="truncate text-xs">{j.error_code ? (ERROR_CODE_LABEL[j.error_code] ?? j.error_code) : "—"}</span>
                    {j.error_code ? <span className="truncate font-mono text-[11px] text-(--c-9a9b94)">{j.error_code}</span> : null}
                  </div>
                  <div className="hidden min-w-0 flex-col gap-px xl:flex">
                    <span className="line-clamp-2 text-xs text-(--c-4a4b46)" title={j.error_message ?? ""}>
                      {j.error_message ?? "—"}
                    </span>
                    {shot ? (
                      <span className="truncate font-mono text-[11px] text-(--c-9a9b94)" title={j.error_screenshot_path ?? ""}>
                        {shot}
                      </span>
                    ) : null}
                  </div>
                  <span className="hidden text-xs text-(--c-7a7b75) tabular-nums md:block">{formatDateTime(j.updated_at)}</span>
                  <JobActions job={j} role={profile.role} />
                </ListRow>
              );
            })}
          </>
        )}
      </ListCard>

      <ListCard>
        <ListTitle title="Últimos logs de erro" count={logs.length} />
        {logs.length === 0 ? (
          <ListEmptyText>Sem logs de erro.</ListEmptyText>
        ) : (
          logs.map((l) => (
            <ListRow key={l.id} grid={LOG_GRID}>
              <span className="text-xs text-(--c-7a7b75) tabular-nums">{formatDateTime(l.created_at)}</span>
              <span className="truncate text-xs">
                {l.job_id ? (
                  <Link href={`/history/${l.job_id}`} className="text-foreground hover:underline">
                    {l.automation_jobs?.clients?.trade_name || l.automation_jobs?.clients?.legal_name || "Job"} ·{" "}
                    {formatCompetence(l.automation_jobs?.competence)}
                  </Link>
                ) : (
                  "Sistema"
                )}
              </span>
              <span className="font-mono text-xs break-words text-(--c-b42323)">{l.message}</span>
            </ListRow>
          ))
        )}
      </ListCard>
    </>
  );
}
