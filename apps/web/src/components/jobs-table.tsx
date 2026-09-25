import { History } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/page-header";
import { JobStatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompetence } from "@/lib/competence";
import { formatDateTime, formatDuration } from "@/lib/format";
import { ERROR_CODE_LABEL, TASK_TYPE_LABEL } from "@/lib/status";
import type { AutomationJob } from "@/lib/types";

export function JobsTable({
  jobs,
  users,
  showClient = true,
}: {
  jobs: AutomationJob[];
  users?: Record<string, string>;
  showClient?: boolean;
}) {
  if (jobs.length === 0) return <EmptyState icon={<History />} title="Nenhuma execução encontrada" />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showClient ? <TableHead>Cliente</TableHead> : null}
            {users ? <TableHead>Usuário</TableHead> : null}
            <TableHead>Data</TableHead>
            <TableHead>Competência</TableHead>
            <TableHead>Operação</TableHead>
            <TableHead>Resultado</TableHead>
            <TableHead>Duração</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              {showClient ? (
                <TableCell>
                  <p className="font-medium">{job.clients?.trade_name || job.clients?.legal_name}</p>
                  <p className="text-xs text-muted-foreground">{job.clients?.client_code}</p>
                </TableCell>
              ) : null}
              {users ? (
                <TableCell className="text-sm">{job.created_by ? users[job.created_by] ?? "—" : "Sistema"}</TableCell>
              ) : null}
              <TableCell className="text-sm">{formatDateTime(job.created_at)}</TableCell>
              <TableCell>{formatCompetence(job.competence)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {job.operations.map((o) => TASK_TYPE_LABEL[o]).join(", ")}
              </TableCell>
              <TableCell>
                <div className="space-y-0.5">
                  <JobStatusBadge status={job.status} />
                  {job.error_code ? (
                    <p className="text-[11px] text-red-600">{ERROR_CODE_LABEL[job.error_code] ?? job.error_code}</p>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {job.started_at ? formatDuration(job.started_at, job.finished_at ?? job.updated_at) : "—"}
              </TableCell>
              <TableCell className="text-right">
                <Link href={`/history/${job.id}`} className="text-xs font-medium text-sky-700 hover:underline">
                  Detalhes
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
