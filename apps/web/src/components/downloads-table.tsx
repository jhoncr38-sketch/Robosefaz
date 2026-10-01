import { Download, FileArchive, FolderOpen, Info, TriangleAlert, X } from "lucide-react";
import Link from "next/link";

import { ListEmptyText, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { driveDownloadUrl, isEmptyZip } from "@/lib/downloads";
import { formatBytes, formatDateTime } from "@/lib/format";
import { type NoteAlert, notesLabel } from "@/lib/note-count";
import { DOCUMENT_LABEL } from "@/lib/status";
import type { DownloadRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// Os ZIPs ficam no computador do robô (ou no Google Drive), fora do alcance do site.
// "Abrir pasta" usa o link "siatrobo://" registrado pelo instalador: o Windows abre o
// Explorer com o arquivo selecionado, no computador onde o robô está instalado.
// "Baixar" (notas no Google Drive) abre a nota no Drive, em qualquer computador.
export const OPEN_FOLDER_URL = (id: string) => `siatrobo://abrir/${id}`;

// sem rolagem lateral: no celular, só a primeira coluna e os botões. Com o cliente, o nome do
// arquivo fica no ícone de detalhes (a empresa já aparece na primeira coluna).
const GRID_CLIENT =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_96px_170px_150px]";
const GRID_NO_CLIENT = "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[64px_120px_minmax(0,1fr)_140px]";

// "2.308 notas"; com aviso, em amarelo e com a explicação ao passar o mouse
function NoteCount({ d, alert }: { d: DownloadRow; alert?: NoteAlert }) {
  const label = isEmptyZip(d) ? "ZIP vazio" : d.note_count == null ? null : notesLabel(d.note_count);
  if (!alert) return label ? <span>{label}</span> : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 font-medium text-(--c-9a6205)"
          aria-label={`Conferir: ${alert.text}`}
        >
          <TriangleAlert className="size-3" />
          {label ?? notesLabel(alert.count)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs">
        <div className="space-y-1">
          <p className="font-medium">Vale conferir este mês</p>
          <p>{alert.text}</p>
          <p className="opacity-70">
            Pode ser normal (empresa parada, férias). Se não for, confira no SIAT se vieram todas as notas do mês.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// nome, tamanho, data, local e SHA-256 do arquivo, ao passar o mouse no "i"
function FileDetails({ d, withName }: { d: DownloadRow; withName: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="shrink-0 text-(--c-9a9b94) hover:text-foreground" aria-label="Detalhes do arquivo">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md text-[11px]">
        <div className="space-y-1">
          {withName ? <p className="font-mono break-all">{d.filename}</p> : null}
          <p>
            {isEmptyZip(d) ? "ZIP vazio" : formatBytes(d.size)} · baixado em {formatDateTime(d.downloaded_at)}
          </p>
          <p>
            <span className="opacity-70">Local: </span>
            <span className="font-mono break-all">{d.filepath}</span>
          </p>
          <p>
            <span className="opacity-70">SHA-256: </span>
            <span className="font-mono break-all">{d.checksum}</span>
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// tipo e, embaixo, a quantidade de notas (e os detalhes do arquivo, quando não há a coluna Arquivo)
function TypeCell({ d, alert, details }: { d: DownloadRow; alert?: NoteAlert; details: boolean }) {
  return (
    <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
      <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-xs whitespace-nowrap text-(--c-4a4b46)">
        {DOCUMENT_LABEL[d.document_type]}
      </span>
      <span className="flex items-center gap-1 pl-0.5 text-[11px] text-(--c-9a9b94) tabular-nums">
        <NoteCount d={d} alert={alert} />
        {details ? <FileDetails d={d} withName /> : null}
      </span>
    </div>
  );
}

// página do cliente e do trabalho: o arquivo é a coluna principal (no celular, com a quantidade)
function FileCell({ d, alert, className, count }: { d: DownloadRow; alert?: NoteAlert; className?: string; count?: boolean }) {
  return (
    <div className={cn("min-w-0 flex-col gap-px", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs">{d.filename}</span>
        <FileDetails d={d} withName={false} />
      </div>
      <span className="flex items-center gap-1 text-[11px] text-(--c-9a9b94) tabular-nums">
        {count ? (
          <>
            <NoteCount d={d} alert={alert} /> ·
          </>
        ) : null}
        <span>
          {isEmptyZip(d) ? null : <>{formatBytes(d.size)} · </>}baixado em {formatDateTime(d.downloaded_at)}
        </span>
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

/** "3 meses para conferir": liga e desliga o filtro (só aparece quando há aviso). */
export function NotesToCheckLink({ count, active, href }: { count: number; active: boolean; href: string }) {
  if (count === 0 && !active) return null;
  return (
    <Link
      href={href}
      className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-(--c-fdf4e3) px-2.5 py-1.5 text-xs font-medium text-(--c-9a6205) hover:no-underline"
      title="Meses sem notas ou com bem menos notas que os meses anteriores do mesmo cliente e tipo"
    >
      <TriangleAlert className="size-3.5" />
      {active ? (
        <>
          Mostrando só os para conferir <X className="size-3.5" />
        </>
      ) : count === 1 ? (
        "1 mês para conferir"
      ) : (
        `${count} meses para conferir`
      )}
    </Link>
  );
}

export function DownloadsTable({
  rows,
  showClient = true,
  drive = false,
  alerts = {},
}: {
  rows: DownloadRow[];
  showClient?: boolean;
  /** notas no Google Drive: mostra o botão Baixar */
  drive?: boolean;
  /** mês "estranho" (nenhuma nota ou queda brusca), pelo id do download */
  alerts?: Record<string, NoteAlert>;
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
        {showClient ? null : <span className="hidden md:block">Arquivo</span>}
        <span className="text-right">Ação</span>
      </ListHead>
      {rows.map((d) => (
        <ListRow key={d.id} grid={grid}>
          {showClient ? (
            <PrimaryCell
              title={d.clients?.trade_name || d.clients?.legal_name}
              sub={
                <>
                  {alerts[d.id] ? (
                    // no celular a coluna do tipo some: o aviso vai no começo da linha do cliente
                    <TriangleAlert
                      className="mr-1 inline size-3 align-[-2px] text-(--c-9a6205) md:hidden"
                      aria-label="Vale conferir"
                    />
                  ) : null}
                  <span className="font-mono">{d.clients?.client_code}</span>
                  <span className="md:hidden">
                    {" "}
                    · {formatCompetence(d.competence)} · {DOCUMENT_LABEL[d.document_type]}
                  </span>
                </>
              }
            />
          ) : (
            <FileCell d={d} alert={alerts[d.id]} className="flex md:hidden" count />
          )}
          <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCompetence(d.competence)}</span>
          <TypeCell d={d} alert={alerts[d.id]} details={showClient} />
          {showClient ? null : <FileCell d={d} className="hidden md:flex" />}
          <div className="flex items-center justify-end gap-1.5">
            <RowActions d={d} drive={drive} />
          </div>
        </ListRow>
      ))}
    </>
  );
}
