import { FileArchive, FolderOpen, Info } from "lucide-react";

import { ListEmptyText, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_LABEL } from "@/lib/status";
import type { DownloadRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// Os ZIPs ficam no computador do robô, fora do alcance do site. O botão usa o
// link "siatrobo://" registrado pelo instalador: o Windows abre o Explorer com
// o arquivo selecionado, no computador onde o SIAT Robô está instalado.
export const OPEN_FOLDER_URL = (id: string) => `siatrobo://abrir/${id}`;

// sem rolagem lateral: no celular, só a primeira coluna e o botão
const GRID_CLIENT =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1.2fr)_64px_110px_minmax(0,1.6fr)_120px]";
const GRID_NO_CLIENT = "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[64px_110px_minmax(0,1fr)_120px]";

function FileCell({ d, className }: { d: DownloadRow; className?: string }) {
  return (
    <div className={cn("min-w-0 flex-col gap-px", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs">{d.filename}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="shrink-0 text-[#9a9b94] hover:text-foreground" aria-label="Detalhes do arquivo">
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-md space-y-1 text-[11px]">
            <p>
              <span className="text-muted-foreground">Local: </span>
              <span className="font-mono break-all">{d.filepath}</span>
            </p>
            <p>
              <span className="text-muted-foreground">SHA-256: </span>
              <span className="font-mono break-all">{d.checksum}</span>
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      <span className="text-[11px] text-[#9a9b94] tabular-nums">
        {formatBytes(d.size)} · baixado em {formatDateTime(d.downloaded_at)}
      </span>
    </div>
  );
}

export function DownloadsTable({ rows, showClient = true }: { rows: DownloadRow[]; showClient?: boolean }) {
  if (rows.length === 0) {
    return showClient ? (
      <EmptyState
        icon={<FileArchive />}
        title="Nenhum arquivo baixado"
        description="Os ZIPs aparecem aqui assim que o robô encontra os agendamentos processados pela SEFAZ."
      />
    ) : (
      <ListEmptyText>Nenhum arquivo baixado.</ListEmptyText>
    );
  }
  const grid = showClient ? GRID_CLIENT : GRID_NO_CLIENT;
  return (
    <>
      <ListHead grid={grid}>
        {showClient ? <span>Cliente</span> : <span className="md:hidden">Arquivo</span>}
        <span className="hidden md:block">Comp.</span>
        <span className="hidden md:block">Tipo</span>
        <span className="hidden md:block">Arquivo</span>
        <span className="text-right">Ação</span>
      </ListHead>
      {rows.map((d) => (
        <ListRow key={d.id} grid={grid}>
          {showClient ? (
            <PrimaryCell
              title={d.clients?.trade_name || d.clients?.legal_name}
              sub={
                <>
                  <span className="font-mono">{d.clients?.client_code}</span>
                  <span className="md:hidden">
                    {" "}
                    · {formatCompetence(d.competence)} · {DOCUMENT_LABEL[d.document_type]}
                  </span>
                </>
              }
            />
          ) : (
            <FileCell d={d} className="flex md:hidden" />
          )}
          <span className="hidden font-mono text-[12.5px] text-[#4a4b46] md:block">{formatCompetence(d.competence)}</span>
          <span className="hidden md:block">
            <span className="rounded bg-[#f2f2ef] px-1.5 py-0.5 text-xs whitespace-nowrap text-[#4a4b46]">
              {DOCUMENT_LABEL[d.document_type]}
            </span>
          </span>
          <FileCell d={d} className="hidden md:flex" />
          <div className="flex justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="sm">
                  <a href={OPEN_FOLDER_URL(d.id)} className="text-foreground hover:no-underline">
                    <FolderOpen /> <span className="hidden sm:inline">Abrir pasta</span>
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64 text-xs">
                Abre a pasta com o arquivo selecionado, no computador onde o SIAT Robô está instalado.
              </TooltipContent>
            </Tooltip>
          </div>
        </ListRow>
      ))}
    </>
  );
}
