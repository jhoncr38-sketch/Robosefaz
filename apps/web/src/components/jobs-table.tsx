import { History } from "lucide-react";

import { ListEmptyText, ListHead, ListRow, OpTags, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { JobStatusBadge } from "@/components/status-badge";
import { formatCompetence } from "@/lib/competence";
import { formatDateTime, formatDuration } from "@/lib/format";
import { ERROR_CODE_LABEL } from "@/lib/status";
import type { AutomationJob } from "@/lib/types";

// sem rolagem lateral: no celular, só a primeira coluna e o resultado;
// usuário e operações aparecem a partir de telas largas
const GRID_CLIENT =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1.4fr)_120px_64px_minmax(0,1.2fr)_70px] xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_120px_64px_130px_minmax(0,1.2fr)_70px]";
const GRID_NO_CLIENT =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[120px_64px_minmax(0,1.2fr)_70px] xl:grid-cols-[minmax(0,1fr)_120px_64px_130px_minmax(0,1.2fr)_70px]";

export function JobsTable({
  jobs,
  users = {},
  showClient = true,
}: {
  jobs: AutomationJob[];
  users?: Record<string, string>;
  showClient?: boolean;
}) {
  if (jobs.length === 0) {
    return showClient ? (
      <EmptyState icon={<History />} title="Nenhuma execução encontrada" />
    ) : (
      <ListEmptyText>Nenhuma execução encontrada.</ListEmptyText>
    );
  }
  const grid = showClient ? GRID_CLIENT : GRID_NO_CLIENT;
  const who = (job: AutomationJob) => (job.created_by ? (users[job.created_by] ?? "—") : "Sistema");

  return (
    <>
      <ListHead grid={grid}>
        {showClient ? <span>Cliente</span> : <span className="md:hidden">Execução</span>}
        <span className="hidden xl:block">Usuário</span>
        <span className="hidden md:block">Data</span>
        <span className="hidden md:block">Comp.</span>
        <span className="hidden xl:block">Operações</span>
        <span className="text-right md:text-left">Resultado</span>
        <span className="hidden text-right md:block">Duração</span>
      </ListHead>
      {jobs.map((job) => (
        <ListRow key={job.id} grid={grid} href={`/history/${job.id}`}>
          {showClient ? (
            <PrimaryCell
              title={job.clients?.trade_name || job.clients?.legal_name}
              sub={
                <>
                  <span className="font-mono">{job.clients?.client_code}</span>
                  <span className="md:hidden">
                    {" "}
                    · {formatCompetence(job.competence)} · {formatDateTime(job.created_at)}
                  </span>
                </>
              }
            />
          ) : (
            <PrimaryCell
              className="md:hidden"
              title={formatCompetence(job.competence)}
              sub={`${formatDateTime(job.created_at)} · ${who(job)}`}
            />
          )}
          <span className="hidden truncate text-xs text-(--c-4a4b46) xl:block">{who(job)}</span>
          <span className="hidden text-xs text-(--c-4a4b46) tabular-nums md:block">{formatDateTime(job.created_at)}</span>
          <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCompetence(job.competence)}</span>
          <span className="hidden xl:block">
            <OpTags ops={job.operations} />
          </span>
          <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
            <JobStatusBadge status={job.status} />
            {job.error_code ? (
              <span className="max-w-full truncate text-[11px] text-(--c-b42323)">
                {ERROR_CODE_LABEL[job.error_code] ?? job.error_code}
              </span>
            ) : null}
          </div>
          <span className="hidden text-right font-mono text-[11.5px] text-(--c-6b6c66) md:block">
            {job.started_at ? formatDuration(job.started_at, job.finished_at ?? job.updated_at) : "—"}
          </span>
        </ListRow>
      ))}
    </>
  );
}
