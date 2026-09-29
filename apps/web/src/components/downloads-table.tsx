import { Download, FileArchive, FolderOpen, Info } from "lucide-react";

import { ListEmptyText, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { driveDownloadUrl, isEmptyZip } from "@/lib/downloads";
import { formatBytes, formatDateTime } from "@/lib/format";
import { DOCUMENT_LABEL } from "@/lib/status";
import type { DownloadRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// Os ZIPs ficam no computador do robô (ou no Google Drive), fora do alcance do site.
// "Abrir pasta" usa o link "siatrobo://" registrado pelo instalador: o Windows abre o
// Explorer com o arquivo selecionado, no computador onde o robô está instalado.
// "Baixar" (notas no Google Drive) abre a nota no Drive, em qualquer computador.
export const OPEN_FOLDER_URL = (id: string) => `siatrobo://abrir/${id}`;

// sem rolagem lateral: no celular, só a primeira coluna e os botões
const GRID_CLIENT =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1.2fr)_64px_110px_minmax(0,1.6fr)_140px]";
const GRID_NO_CLIENT = "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[64px_110px_minmax(0,1fr)_140px]";

function FileCell({ d, className }: { d: DownloadRow; className?: string }) {
  return (
    <div className={cn("min-w-0 flex-col gap-px", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs">{d.filename}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="shrink-0 text-(--c-9a9b94) hover:text-foreground" aria-label="Detalhes do arquivo">
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
      <span className="text-[11px] text-(--c-9a9b94) tabular-nums">
        {isEmptyZip(d) ? "ZIP vazio" : formatBytes(d.size)} · baixado em {formatDateTime(d.downloaded_at)}
      </span>
    </div>
  );
}

function RowActions({ d, drive }: { d: DownloadRow; drive: boolean }) {
  if (isEmptyZip(d)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default rounded bg-(--c-f2f2ef) px-2 py-1 text-xs whitespace-nowrap text-(--c-6b6b66)">
            Sem notas
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs">
          O SIAT entregou um ZIP vazio: não houve nota neste período. Não há nada para baixar.
        </TooltipContent>
      </Tooltip>
    );
  }
  const driveUrl = driveDownloadUrl(d.drive_file_id);
  const openFolder = (
    <a href={OPEN_FOLDER_URL(d.id)} className="text-foreground hover:no-underline" aria-label="Abrir pasta">
      <FolderOpen /> {drive ? null : <span className="hidden sm:inline">Abrir pasta</span>}
    </a>
  );
  return (
    <>
      {drive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {driveUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={driveUrl} target="_blank" rel="noopener noreferrer" className="text-foreground hover:no-underline">
                  <Download /> Baixar
                </a>
              </Button>
            ) : (
              // desabilitado não recebe o mouse: o span mostra a explicação
              <span tabIndex={0} className="inline-flex">
                <Button variant="outline" size="sm" disabled>
                  <Download /> Baixar
                </Button>
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-xs">
            {driveUrl
              ? "Baixa a nota do Google Drive. Funciona em qualquer computador, para quem tem a pasta JR Sistema - Notas compartilhada."
              : "Esta nota ainda não está no Google Drive. O botão libera alguns minutos depois que ela chega lá."}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="outline" size={drive ? "icon-sm" : "sm"}>
            {openFolder}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs">
          Abre a pasta com o arquivo selecionado, no computador onde o robô está instalado.
        </TooltipContent>
      </Tooltip>
    </>
  );
}

export function DownloadsTable({
  rows,
  showClient = true,
  drive = false,
}: {
  rows: DownloadRow[];
  showClient?: boolean;
  /** notas no Google Drive: mostra o botão Baixar */
  drive?: boolean;
}) {
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
          <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCompetence(d.competence)}</span>
          <span className="hidden md:block">
            <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-xs whitespace-nowrap text-(--c-4a4b46)">
              {DOCUMENT_LABEL[d.document_type]}
            </span>
          </span>
          <FileCell d={d} className="hidden md:flex" />
          <div className="flex items-center justify-end gap-1.5">
            <RowActions d={d} drive={drive} />
          </div>
        </ListRow>
      ))}
    </>
  );
}
