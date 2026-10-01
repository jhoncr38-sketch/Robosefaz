import { Download, FileArchive, FolderOpen, Info, TriangleAlert, X } from "lucide-react";
import Link from "next/link";

import { ListEmptyText, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompetence } from "@/lib/competence";
import { driveDownloadUrl, isEmptyZip } from "@/lib/downloads";
import { formatBytes, formatDateTime } from "@/lib/format";
import { downloadEntries, type MonthSummary, type NoMovementRow, type Situation } from "@/lib/no-movement";
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
  return <AlertCount label={label ?? notesLabel(alert.count)} alert={alert} />;
}

function AlertCount({ label, alert }: { label: string; alert: NoteAlert }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 font-medium text-(--c-9a6205)"
          aria-label={`Conferir: ${alert.text}`}
        >
          <TriangleAlert className="size-3" />
          {label}
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

const NO_MOVEMENT_PILL =
  "cursor-default rounded bg-(--c-f2f2ef) px-2 py-1 text-xs whitespace-nowrap text-(--c-6b6b66)";

// "Sem movimento": o SIAT processou o pedido e não havia nota no período; não existe arquivo
function NoMovementPill({ n }: { n: NoMovementRow }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={NO_MOVEMENT_PILL}>
          Sem movimento
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">
        O SIAT processou o pedido{n.external_request_id ? ` nº ${n.external_request_id}` : ""} e não havia notas neste
        período. Conferido em {formatDateTime(n.checked_at)}. Não há arquivo para baixar.
      </TooltipContent>
    </Tooltip>
  );
}

// tipo e, embaixo, "0 notas" (em amarelo quando o mês costuma ter notas)
function NoMovementTypeCell({ n, alert }: { n: NoMovementRow; alert?: NoteAlert }) {
  return (
    <div className="hidden min-w-0 flex-col items-start gap-1 md:flex">
      <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-xs whitespace-nowrap text-(--c-4a4b46)">
        {DOCUMENT_LABEL[n.document_type]}
      </span>
      <span className="flex items-center gap-1 pl-0.5 text-[11px] text-(--c-9a9b94) tabular-nums">
        {alert ? <AlertCount label="0 notas" alert={alert} /> : <span>0 notas</span>}
      </span>
    </div>
  );
}

// página do cliente e do trabalho: no lugar do arquivo
function NoMovementFileCell({ n, alert, className }: { n: NoMovementRow; alert?: NoteAlert; className?: string }) {
  return (
    <div className={cn("min-w-0 flex-col gap-px", className)}>
      <span className="truncate text-xs text-(--c-6b6b66)">Sem arquivo: não houve notas no período</span>
      <span className="flex items-center gap-1 text-[11px] text-(--c-9a9b94) tabular-nums">
        {alert ? (
          <>
            <AlertCount label="0 notas" alert={alert} /> ·
          </>
        ) : null}
        <span>conferido no SIAT em {formatDateTime(n.checked_at)}</span>
      </span>
    </div>
  );
}

function RowActions({ d, drive }: { d: DownloadRow; drive: boolean }) {
  if (isEmptyZip(d)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={NO_MOVEMENT_PILL}>Sem movimento</span>
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

/**
 * Resumo da competência escolhida: quantas empresas e tipos vieram com notas, sem movimento ou
 * ainda sem resposta. "Com notas" e "Sem movimento" filtram a lista.
 */
export function MonthSummaryBar({
  competence,
  summary,
  hrefFor,
}: {
  competence: string;
  summary: MonthSummary;
  hrefFor: (situation: Situation) => string;
}) {
  if (summary.clients === 0) return null;
  const link = "font-medium text-foreground underline-offset-2 hover:underline";
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-(--c-efefeb) px-3.5 py-2 text-xs text-(--c-6b6b66)">
      <span>
        <strong className="font-medium text-foreground">{formatCompetence(competence)}</strong> ·{" "}
        {summary.clients === 1 ? "1 empresa" : `${summary.clients} empresas`}:
      </span>
      <Link href={hrefFor("com-notas")} className={link}>
        {summary.withNotes} com notas
      </Link>
      <span>·</span>
      <Link href={hrefFor("sem-movimento")} className={link}>
        {summary.noMovement} sem movimento
      </Link>
      {summary.waiting > 0 ? (
        <>
          <span>·</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-default">
                {summary.waiting} ainda sem resposta
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-xs">
              Pedidos na fila, aguardando a SEFAZ ou com erro. Acompanhe na Fila de processamento e no Histórico.
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      <span className="text-(--c-9a9b94)">(cada empresa conta uma vez por tipo de nota)</span>
    </div>
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
  empty = [],
  situation,
  showClient = true,
  drive = false,
  alerts = {},
}: {
  rows: DownloadRow[];
  /** processados sem notas no período (não há arquivo) */
  empty?: NoMovementRow[];
  situation?: Situation;
  showClient?: boolean;
  /** notas no Google Drive: mostra o botão Baixar */
  drive?: boolean;
  /** mês "estranho" (nenhuma nota ou queda brusca), pelo id do download ou da linha sem movimento */
  alerts?: Record<string, NoteAlert>;
}) {
  const entries = downloadEntries(rows, empty, situation);
  if (entries.length === 0) {
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
      {entries.map((e) =>
        e.kind === "empty" ? (
          <ListRow key={e.n.id} grid={grid}>
            {showClient ? (
              <ClientCell client={e.n.clients} competence={e.n.competence} type={e.n.document_type} alert={alerts[e.n.id]} />
            ) : (
              <NoMovementFileCell n={e.n} alert={alerts[e.n.id]} className="flex md:hidden" />
            )}
            <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCompetence(e.n.competence)}</span>
            <NoMovementTypeCell n={e.n} alert={alerts[e.n.id]} />
            {showClient ? null : <NoMovementFileCell n={e.n} className="hidden md:flex" />}
            <div className="flex items-center justify-end gap-1.5">
              <NoMovementPill n={e.n} />
            </div>
          </ListRow>
        ) : (
          <FileRow key={e.d.id} d={e.d} grid={grid} showClient={showClient} drive={drive} alert={alerts[e.d.id]} />
        ),
      )}
    </>
  );
}

function ClientCell({
  client,
  competence,
  type,
  alert,
}: {
  client?: DownloadRow["clients"];
  competence: string;
  type: DownloadRow["document_type"];
  alert?: NoteAlert;
}) {
  return (
    <PrimaryCell
      title={client?.trade_name || client?.legal_name}
      sub={
        <>
          {alert ? (
            // no celular a coluna do tipo some: o aviso vai no começo da linha do cliente
            <TriangleAlert className="mr-1 inline size-3 align-[-2px] text-(--c-9a6205) md:hidden" aria-label="Vale conferir" />
          ) : null}
          <span className="font-mono">{client?.client_code}</span>
          <span className="md:hidden">
            {" "}
            · {formatCompetence(competence)} · {DOCUMENT_LABEL[type]}
          </span>
        </>
      }
    />
  );
}

function FileRow({
  d,
  grid,
  showClient,
  drive,
  alert,
}: {
  d: DownloadRow;
  grid: string;
  showClient: boolean;
  drive: boolean;
  alert?: NoteAlert;
}) {
  return (
    <ListRow grid={grid}>
      {showClient ? (
        <ClientCell client={d.clients} competence={d.competence} type={d.document_type} alert={alert} />
      ) : (
        <FileCell d={d} alert={alert} className="flex md:hidden" count />
      )}
      <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCompetence(d.competence)}</span>
      <TypeCell d={d} alert={alert} details={showClient} />
      {showClient ? null : <FileCell d={d} className="hidden md:flex" />}
      <div className="flex items-center justify-end gap-1.5">
        <RowActions d={d} drive={drive} />
      </div>
    </ListRow>
  );
}
