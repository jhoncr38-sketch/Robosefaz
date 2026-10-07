"use client";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileInput,
  FileOutput,
  FileX,
  FolderDown,
  FolderOpen,
  History,
  Receipt,
  Search,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ListEmptyText } from "@/components/data-list";
import { StatusTabs } from "@/components/list-extras";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { normalizeCNPJ } from "@/lib/cnpj";
import { formatCompetence } from "@/lib/competence";
import { driveDownloadUrl, driveFolderUrl } from "@/lib/downloads";
import {
  blockKey,
  type FileVersion,
  filterBlocks,
  type MonthBlock,
  type MonthClient,
  type TypeFilter,
} from "@/lib/downloads-month";
import { formatDateTime } from "@/lib/format";
import { baseDocument, DOCUMENT_LABEL, isCanceledDocument } from "@/lib/status";
import { cn } from "@/lib/utils";

/** Abre o Explorer com o arquivo selecionado, no computador do robô (link registrado pelo instalador). */
const OPEN_FOLDER_URL = (id: string) => `siatrobo://abrir/${id}`;

export type MonthTab = "all" | "com" | "sem" | "resp" | "conf";

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(150px,1fr)_minmax(0,2.2fr)_84px]";

const ICON: Record<Exclude<TypeFilter, "all">, LucideIcon> = {
  nfce: Receipt,
  emit: FileOutput,
  receb: FileInput,
  canc: FileX,
};

const TYPE_CHIPS: [TypeFilter, string][] = [
  ["all", "Todos os tipos"],
  ["nfce", "NFC-e"],
  ["emit", "Emitidas"],
  ["receb", "Recebidas"],
  ["canc", "Canceladas"],
];

const NUM = new Intl.NumberFormat("pt-BR");

const WAITING_TEXT: Partial<Record<MonthBlock["state"], string>> = {
  queued: "na fila",
  waiting: "aguardando SEFAZ",
  error: "com erro",
};

function IconButton({
  href,
  label,
  external = false,
  children,
}: {
  href: string;
  label: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          aria-label={label}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="grid size-[30px] place-items-center rounded-[7px] border border-input bg-card text-foreground hover:bg-(--c-fafaf8) hover:no-underline"
        >
          {children}
        </a>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function originLabel(v: FileVersion): string {
  if (v.forced === true) return "forçar reagendamento";
  if (v.forced === false) return "agendamento";
  return "origem não registrada";
}

/**
 * Mesmo mês e tipo exportado mais de uma vez (ex.: "Forçar reagendamento" com notas novas): o robô
 * grava uma versão ao lado da anterior. Passar o mouse resume; clicar lista cada versão com o
 * botão de baixar.
 */
function VersionsBadge({ versions, drive }: { versions: FileVersion[]; drive: boolean }) {
  const latest = versions[0];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${versions.length} versões deste mês · a atual é de ${formatDateTime(latest.downloaded_at)}. Clique para ver o histórico.`}
          className="ml-1.5 inline-flex h-[18px] items-center gap-1 rounded-full border border-(--c-e3e3df) bg-(--c-f5f5f2) px-1.5 align-middle text-[10.5px] font-medium text-(--c-6b6c66) transition-colors hover:border-(--c-a9cdb8) hover:text-primary"
        >
          <History className="size-3" /> {versions.length} versões
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-2 text-xs">
        <p className="font-medium">Versões deste mês</p>
        <ul className="divide-y divide-(--c-efefeb)">
          {versions.map((v, i) => {
            const url = drive ? driveDownloadUrl(v.drive_file_id) : OPEN_FOLDER_URL(v.id);
            const notes =
              v.note_count === null ? "" : ` · ${NUM.format(v.note_count)} ${v.note_count === 1 ? "nota" : "notas"}`;
            const delta = v.delta !== null && v.delta !== 0 ? ` (${v.delta > 0 ? "+" : ""}${NUM.format(v.delta)})` : "";
            return (
              <li key={v.id} className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[11.5px]">
                    {formatDateTime(v.downloaded_at)}
                    {i === 0 ? (
                      <span className="ml-1.5 rounded bg-(--c-e6f4ec) px-1 py-px font-sans text-[10px] font-medium text-primary">atual</span>
                    ) : null}
                  </p>
                  <p className="text-(--c-6b6c66)">
                    {originLabel(v)}
                    {notes}
                    {delta}
                  </p>
                </div>
                {url ? (
                  <a
                    href={url}
                    target={drive ? "_blank" : undefined}
                    rel="noopener noreferrer"
                    title={`Baixar · ${v.filename}`}
                    aria-label={`Baixar a versão de ${formatDateTime(v.downloaded_at)}`}
                    className="grid size-6 shrink-0 place-items-center rounded-md bg-(--c-f3faf6) text-primary transition-colors hover:bg-(--c-dff1e6) hover:no-underline"
                  >
                    <Download className="size-3.5" />
                  </a>
                ) : (
                  <span
                    title="Esta versão ainda não está no Google Drive."
                    className="grid size-6 shrink-0 cursor-not-allowed place-items-center rounded-md bg-(--c-f5f5f2) text-(--c-a3a39e)"
                  >
                    <Download className="size-3.5" />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] leading-snug text-(--c-6b6c66)">
          Cada exportação nova gravou um arquivo ao lado do anterior porque o conteúdo mudou. A atual é a mais completa;
          nada é apagado.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Um tipo de nota do mês: ícone, rótulo, quantidade e o botão de baixar. */
function Block({ b, drive }: { b: MonthBlock; drive: boolean }) {
  const key = blockKey(b.doc);
  const canceled = isCanceledDocument(b.doc);
  const alert = b.alert;
  const blank = b.state !== "file";
  const Icon = alert ? TriangleAlert : ICON[key];
  const driveUrl = b.file ? driveDownloadUrl(b.file.drive_file_id) : null;

  let body: React.ReactNode;
  if (b.state === "file" || alert) {
    const count = b.count;
    body =
      count === null ? (
        <span className="text-xs text-(--c-6b6c66)">baixado</span>
      ) : (
        <>
          <b className={cn("font-mono text-[13.5px] font-semibold tracking-[-0.01em]", alert ? "text-(--c-9a6205)" : "text-foreground")}>
            {NUM.format(count)}
          </b>{" "}
          <span className="text-[11.5px] text-(--c-6b6c66)">
            {count === 1 ? "nota" : "notas"}
            {alert ? ` · média ${NUM.format(alert.average)}` : ""}
          </span>
        </>
      );
  } else if (b.state === "empty") {
    body = <span className="text-xs text-(--c-6b6c66)">sem movimento</span>;
  } else {
    body = <span className={cn("text-xs", b.state === "error" ? "text-(--c-b42323)" : "text-(--c-6b6c66)")}>{WAITING_TEXT[b.state]}</span>;
  }

  const box = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-[10px] border py-[5px] pr-[5px] pl-1.5",
        alert
          ? "border-(--c-f3dfb4) bg-(--c-fffbf2)"
          : blank
            ? "border-dashed border-(--c-e3e3df) bg-transparent"
            : "border-(--c-e8e8e4) bg-card shadow-[0_1px_2px_rgba(28,29,27,.04)]",
      )}
    >
      <span
        className={cn(
          "grid size-[26px] shrink-0 place-items-center rounded-[7px]",
          alert
            ? "bg-(--c-fdf4e3) text-(--c-b7791f)"
            : blank
              ? "bg-(--c-f5f5f2) text-(--c-a3a39e)"
              : canceled
                ? "bg-(--c-fdecec) text-(--c-b42323)"
                : "bg-(--c-f2f5f3) text-(--c-1f7a4d)",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px leading-[1.2]">
        <span className="text-[11px] whitespace-nowrap text-(--c-6b6c66)">
          {DOCUMENT_LABEL[baseDocument(b.doc)]}
          {canceled ? <span className="ml-1 font-medium text-(--c-b42323)">canceladas</span> : null}
        </span>
        <span className="whitespace-nowrap">
          {body}
          {b.versions && b.versions.length > 1 ? <VersionsBadge versions={b.versions} drive={drive} /> : null}
        </span>
      </div>
      {b.file ? (
        drive ? (
          driveUrl ? (
            <a
              href={driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Baixar do Google Drive"
              title={`Baixar do Google Drive · ${b.file.filename}`}
              className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-(--c-f3faf6) text-primary transition-colors hover:bg-(--c-dff1e6) hover:no-underline"
            >
              <Download className="size-[15px]" />
            </a>
          ) : (
            <span
              title="Esta nota ainda não está no Google Drive. O botão libera alguns minutos depois que ela chega lá."
              className="grid size-[26px] shrink-0 cursor-not-allowed place-items-center rounded-[7px] bg-(--c-f5f5f2) text-(--c-a3a39e)"
            >
              <Download className="size-[15px]" />
            </span>
          )
        ) : (
          <a
            href={OPEN_FOLDER_URL(b.file.id)}
            aria-label="Abrir pasta"
            title={`Abre a pasta no computador do robô · ${b.file.filename}`}
            className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-(--c-f3faf6) text-primary transition-colors hover:bg-(--c-dff1e6) hover:no-underline"
          >
            <FolderOpen className="size-[15px]" />
          </a>
        )
      ) : null}
    </div>
  );
  if (!alert && !b.file) return box;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={alert ? 0 : -1} className="outline-none">
          {box}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-xs">
        {alert ? (
          <div className="space-y-1">
            <p className="font-medium">Vale conferir este mês</p>
            <p>{alert.text}</p>
            <p className="opacity-70">Pode ser normal (empresa parada, férias). Se não for, confira no SIAT se vieram todas as notas.</p>
          </div>
        ) : b.file ? (
          <p>Baixado em {formatDateTime(b.file.downloaded_at)}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function DownloadsMonth({
  rows,
  competence,
  prevHref,
  nextHref,
  drive,
  monthFolder,
  initialType = "all",
  initialTab = "all",
  initialQuery = "",
}: {
  rows: MonthClient[];
  competence: string;
  prevHref: string | null;
  nextHref: string | null;
  drive: boolean;
  /** "Baixar pasta do mês" (Google Drive) */
  monthFolder: { url: string | null; files: number; clients: number } | null;
  initialType?: TypeFilter;
  initialTab?: MonthTab;
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [type, setType] = useState<TypeFilter>(initialType);
  const [tab, setTab] = useState<MonthTab>(initialTab);

  const counts = useMemo(
    () => ({
      all: rows.length,
      com: rows.filter((r) => r.situation === "com").length,
      sem: rows.filter((r) => r.situation === "sem").length,
      resp: rows.filter((r) => r.situation === "resp").length,
      conf: rows.filter((r) => r.toCheck).length,
    }),
    [rows],
  );

  const term = q.trim().toLowerCase();
  const digits = normalizeCNPJ(term);
  const inTab = rows.filter((r) => (tab === "all" ? true : tab === "conf" ? r.toCheck : r.situation === tab));
  const visible = filterBlocks(
    inTab.filter(
      (r) =>
        !term ||
        r.name.toLowerCase().includes(term) ||
        r.code.toLowerCase().includes(term) ||
        (digits.length >= 3 && r.cnpj.includes(digits)),
    ),
    type,
  );

  const folderTip = monthFolder
    ? monthFolder.url
      ? `${monthFolder.files} arquivo${monthFolder.files === 1 ? "" : "s"} de ${monthFolder.clients} cliente${monthFolder.clients === 1 ? "" : "s"}, cada um na sua pasta do Google Drive. Lá, clique na setinha ao lado do nome da pasta › Fazer download.`
      : "As notas ainda não estão no Google Drive. O botão libera alguns minutos depois que elas chegam lá."
    : "";

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
        <div className="flex items-center gap-1">
          {prevHref ? (
            <Link
              href={prevHref}
              aria-label="Competência anterior"
              className="grid h-8 w-7 place-items-center rounded-[7px] border border-input text-foreground hover:bg-(--c-f2f3ef) hover:no-underline"
            >
              <ChevronLeft className="size-3.5" />
            </Link>
          ) : null}
          <span className="flex h-8 min-w-[76px] items-center justify-center rounded-[7px] border border-input px-2.5 font-mono text-sm font-medium">
            {formatCompetence(competence)}
          </span>
          {nextHref ? (
            <Link
              href={nextHref}
              aria-label="Próxima competência"
              className="grid h-8 w-7 place-items-center rounded-[7px] border border-input text-foreground hover:bg-(--c-f2f3ef) hover:no-underline"
            >
              <ChevronRight className="size-3.5" />
            </Link>
          ) : (
            <span aria-hidden className="grid h-8 w-7 place-items-center rounded-[7px] border border-input opacity-40">
              <ChevronRight className="size-3.5" />
            </span>
          )}
        </div>
        <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
          <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar cliente, código ou CNPJ"
            aria-label="Buscar cliente, código ou CNPJ"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ellipsis outline-none placeholder:text-(--c-6b6c66)"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TYPE_CHIPS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={type === key}
              onClick={() => setType(key)}
              className={cn(
                "flex h-7 items-center rounded-full border px-2.5 text-[12.5px] whitespace-nowrap",
                type === key ? "border-(--c-9fd3b5) bg-(--c-eef7f1) text-(--c-17603b)" : "border-input bg-card text-(--c-3d3e3a)",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {monthFolder && monthFolder.files > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {monthFolder.url ? (
                <a
                  href={monthFolder.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-8 items-center gap-1.5 rounded-[7px] bg-primary px-3 text-[13px] font-medium whitespace-nowrap text-white hover:bg-(--c-196640) hover:no-underline"
                >
                  <FolderDown className="size-3.5" /> Baixar pasta do mês
                </a>
              ) : (
                <span
                  tabIndex={0}
                  className="flex h-8 cursor-not-allowed items-center gap-1.5 rounded-[7px] bg-(--c-a9cdb8) px-3 text-[13px] font-medium whitespace-nowrap text-white"
                >
                  <FolderDown className="size-3.5" /> Baixar pasta do mês
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent className="max-w-72 text-xs">{folderTip}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="border-b border-(--c-efefeb) px-3.5 py-2">
        <StatusTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "Todos", count: counts.all },
            { key: "com", label: "Com notas", count: counts.com },
            { key: "sem", label: "Sem movimento", count: counts.sem },
            { key: "resp", label: "Sem resposta", count: counts.resp },
            {
              key: "conf",
              label: "Para conferir",
              count: counts.conf,
              icon: <TriangleAlert className="size-[13px] text-(--c-9a6205)" />,
            },
          ]}
        />
      </div>

      <div
        className={cn(
          GRID,
          "items-center border-b border-(--c-efefeb) bg-(--c-fafaf8) px-4 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
        )}
      >
        <span>Cliente</span>
        <span className="hidden md:block">Notas do mês</span>
        <span />
      </div>

      {visible.length === 0 ? (
        <ListEmptyText>
          {rows.length === 0
            ? `Nenhuma nota baixada em ${formatCompetence(competence)} ainda.`
            : "Nenhum cliente nesta visão."}
        </ListEmptyText>
      ) : (
        visible.map((r) => {
          const clientFolder = drive ? driveFolderUrl(r.files.find((f) => f.drive_client_folder_id)?.drive_client_folder_id) : null;
          return (
            <div
              key={r.clientId}
              className={cn(GRID, "items-center border-b border-(--c-f2f2ef) px-4 py-3 text-[13px] last:border-b-0 hover:bg-(--c-fafaf8)")}
            >
              <div className="flex min-w-0 flex-col gap-px">
                <Link href={`/clients/${r.clientId}`} className="truncate font-medium text-foreground hover:text-primary" title={r.name}>
                  {r.name}
                </Link>
                <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{r.code}</span>
              </div>
              <div className="col-span-2 flex flex-wrap gap-1.5 md:col-span-1">
                {r.blocks.map((b) => (
                  <Block key={b.id} b={b} drive={drive} />
                ))}
              </div>
              <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 md:col-start-auto md:row-start-auto">
                {clientFolder ? (
                  <IconButton href={clientFolder} label="Baixar tudo do cliente" external>
                    <Download className="size-[13px]" />
                  </IconButton>
                ) : null}
                {r.files.length > 0 ? (
                  <IconButton href={OPEN_FOLDER_URL(r.files[0].id)} label="Abre a pasta no computador do robô">
                    <FolderOpen className="size-3.5" />
                  </IconButton>
                ) : null}
              </div>
            </div>
          );
        })
      )}
      {rows.length > 0 ? (
        <p className="border-t border-(--c-efefeb) px-4 py-3 text-center text-xs text-(--c-6b6c66)">
          Mostrando {visible.length} de {inTab.length} cliente{inTab.length === 1 ? "" : "s"}
        </p>
      ) : null}
    </section>
  );
}
