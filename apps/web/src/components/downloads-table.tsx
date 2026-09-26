import { FileArchive, FolderOpen, Info } from "lucide-react";

import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_LABEL } from "@/lib/status";
import type { DownloadRow } from "@/lib/types";

// Os ZIPs ficam no computador do robô, fora do alcance do site. O botão usa o
// link "siatrobo://" registrado pelo instalador: o Windows abre o Explorer com
// o arquivo selecionado, no computador onde o SIAT Robô está instalado.
export const OPEN_FOLDER_URL = (id: string) => `siatrobo://abrir/${id}`;

export function DownloadsTable({ rows, showClient = true }: { rows: DownloadRow[]; showClient?: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<FileArchive />}
        title="Nenhum arquivo baixado"
        description="Os ZIPs aparecem aqui assim que o robô encontra os agendamentos processados pela SEFAZ."
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
            <TableHead className="text-right">Ação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id}>
              {showClient ? (
                <TableCell className="max-w-56">
                  <p className="truncate font-medium">{d.clients?.trade_name || d.clients?.legal_name}</p>
                  <p className="text-xs text-muted-foreground">{d.clients?.client_code}</p>
                </TableCell>
              ) : null}
              <TableCell className="tabular-nums">{formatCompetence(d.competence)}</TableCell>
              <TableCell>
                <Badge variant="secondary" className="font-normal">
                  {DOCUMENT_LABEL[d.document_type]}
                </Badge>
              </TableCell>
              <TableCell className="max-w-80">
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-mono text-xs">{d.filename}</p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Detalhes do arquivo">
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-md space-y-1 text-[11px]">
                      <p>
                        <span className="text-muted-foreground">Local: </span>
                        <span className="break-all font-mono">{d.filepath}</span>
                      </p>
                      <p>
                        <span className="text-muted-foreground">SHA-256: </span>
                        <span className="break-all font-mono">{d.checksum}</span>
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatBytes(d.size)} · baixado em {formatDateTime(d.downloaded_at)}
                </p>
              </TableCell>
              <TableCell className="text-right">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button asChild variant="outline" size="sm">
                      <a href={OPEN_FOLDER_URL(d.id)}>
                        <FolderOpen /> Abrir pasta
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 text-xs">
                    Abre a pasta com o arquivo selecionado, no computador onde o SIAT Robô está instalado.
                  </TooltipContent>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
