import { Download, FileArchive } from "lucide-react";

import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_LABEL } from "@/lib/status";
import type { DownloadRow } from "@/lib/types";

export function DownloadsTable({ rows, showClient = true }: { rows: DownloadRow[]; showClient?: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<FileArchive />}
        title="Nenhum arquivo baixado"
        description="Os ZIPs aparecem aqui assim que o Collector encontra os agendamentos processados pela SEFAZ."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showClient ? <TableHead>Cliente</TableHead> : null}
            <TableHead>Competência</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Arquivo</TableHead>
            <TableHead>Tamanho</TableHead>
            <TableHead>Baixado em</TableHead>
            <TableHead>SHA-256</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id}>
              {showClient ? (
                <TableCell>
                  <p className="font-medium">{d.clients?.trade_name || d.clients?.legal_name}</p>
                  <p className="text-xs text-muted-foreground">{d.clients?.client_code}</p>
                </TableCell>
              ) : null}
              <TableCell>{formatCompetence(d.competence)}</TableCell>
              <TableCell className="text-sm">{DOCUMENT_LABEL[d.document_type]}</TableCell>
              <TableCell className="max-w-72">
                <p className="truncate font-mono text-xs">{d.filename}</p>
                <p className="truncate text-[11px] text-muted-foreground" title={d.filepath}>
                  {d.filepath}
                </p>
              </TableCell>
              <TableCell className="text-sm tabular-nums">{formatBytes(d.size)}</TableCell>
              <TableCell className="text-sm">{formatDateTime(d.downloaded_at)}</TableCell>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help font-mono text-[11px] text-muted-foreground">{d.checksum.slice(0, 12)}…</span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-[11px]">{d.checksum}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-right">
                <Button asChild variant="outline" size="sm">
                  <a href={`/api/downloads/${d.id}`} download={d.filename}>
                    <Download /> Baixar
                  </a>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
