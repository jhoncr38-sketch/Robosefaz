import { Download, FolderOpen } from "lucide-react";
import type { Metadata } from "next";

import { BulkDownload } from "@/components/bulk-download";
import { ListCard, ListToolbar, LoadMore } from "@/components/data-list";
import { DownloadsTable, MonthSummaryBar, NotesToCheckLink } from "@/components/downloads-table";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requireSession } from "@/lib/auth";
import { formatCompetence, recentCompetences } from "@/lib/competence";
import { bulkTarget, EMPTY_ZIP_BYTES, notesInGoogleDrive } from "@/lib/downloads";
import {
  asZeroCount,
  monthSummary,
  type NoMovementRow,
  parseSituation,
  type Situation,
  SITUATION_LABEL,
} from "@/lib/no-movement";
import { type NoteCountRow, noteAlerts } from "@/lib/note-count";
import { moreHref, newest, parseShown } from "@/lib/paging";
import { DOCUMENT_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { DocumentType, DownloadRow, TaskStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Downloads" };

/** linhas por lote do "Carregar mais" */
const PAGE = 500;

export default async function DownloadsPage({ searchParams }: PageProps<"/downloads">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  const competence = typeof params.competence === "string" ? params.competence : undefined;
  const clientId = typeof params.client === "string" ? params.client : undefined;
  const docType = typeof params.type === "string" ? params.type : undefined;
  const situation = parseSituation(params.situacao);
  const shown = parseShown(params.mostrar, PAGE);

  // arquivos e "sem movimento", cada um com os filtros e a contagem total; a lista mostra os
  // `shown` mais recentes das duas juntas
  let query = supabase
    .from("downloads")
    .select("*, clients(client_code, legal_name, trade_name, cnpj)", { count: "exact" })
    .order("downloaded_at", { ascending: false })
    .limit(shown);
  let emptyQuery = supabase
    .from("downloads_no_movement")
    .select("*", { count: "exact" })
    .order("checked_at", { ascending: false })
    .limit(shown);
  if (competence) {
    query = query.eq("competence", competence);
    emptyQuery = emptyQuery.eq("competence", competence);
  }
  if (clientId) {
    query = query.eq("client_id", clientId);
    emptyQuery = emptyQuery.eq("client_id", clientId);
  }
  if (docType) {
    query = query.eq("document_type", docType);
    emptyQuery = emptyQuery.eq("document_type", docType);
  }
  // ZIP vazio antigo ou contado com 0 notas também é "sem movimento"
  if (situation === "com-notas") query = query.gt("size", EMPTY_ZIP_BYTES).or("note_count.is.null,note_count.gt.0");
  if (situation === "sem-movimento") query = query.or(`size.lte.${EMPTY_ZIP_BYTES},note_count.eq.0`);

  // pedidos do mês (resumo "com notas / sem movimento / sem resposta"): só com a competência escolhida
  let monthTasks = supabase
    .from("automation_tasks")
    .select("client_id, document_type, status, created_at")
    .in("task_type", ["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"])
    .eq("competence", competence ?? "")
    .limit(5000);
  if (clientId) monthTasks = monthTasks.eq("client_id", clientId);
  if (docType) monthTasks = monthTasks.eq("document_type", docType);

  const [files, { data: clients }, drive, { data: counted }, emptyRes, { data: emptyHistory }, { data: tasks }] = await Promise.all([
    query,
    supabase.from("clients").select("id, client_code, legal_name, trade_name, cnpj, active").order("legal_name"),
    notesInGoogleDrive(supabase),
    // meses anteriores de cada cliente e tipo, para o aviso de mês "estranho" (poucos bytes por linha)
    supabase
      .from("downloads")
      .select("id, client_id, document_type, competence, note_count, downloaded_at")
      .not("note_count", "is", null)
      .limit(10000),
    // processados sem notas (sem arquivo): uma linha por cliente, mês e tipo
    situation === "com-notas" ? Promise.resolve({ data: [], count: 0 }) : emptyQuery,
    // todos os "sem movimento" (poucos campos), para o aviso de mês "estranho"
    supabase.from("downloads_no_movement").select("id, client_id, job_id, competence, document_type, checked_at").limit(10000),
    competence ? monthTasks : Promise.resolve({ data: [] }),
  ]);
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));
  const fetchedEmpty = ((emptyRes.data ?? []) as NoMovementRow[]).map((n) => ({ ...n, clients: clientById.get(n.client_id) ?? null }));
  const visible = newest(
    (files.data ?? []) as DownloadRow[],
    fetchedEmpty,
    (d) => d.downloaded_at,
    (n) => n.checked_at,
    shown,
  );
  const all = visible.a;
  const empty = visible.b;
  const total = (files.count ?? 0) + (emptyRes.count ?? 0);
  // "sem movimento" conta como mês com 0 notas no aviso
  const alerts = noteAlerts(
    [...all, ...empty.map(asZeroCount)],
    [...((counted ?? []) as NoteCountRow[]), ...((emptyHistory ?? []) as NoMovementRow[]).map(asZeroCount)],
  );
  const checking = params.conferir === "1";
  const rows = checking ? all.filter((d) => alerts[d.id]) : all;
  const emptyRows = checking ? empty.filter((n) => alerts[n.id]) : empty;
  const toCheck = all.filter((d) => alerts[d.id]).length + empty.filter((n) => alerts[n.id]).length;
  const hrefWith = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    return q.size ? `/downloads?${q}` : "/downloads";
  };
  const client = clientId ? clientById.get(clientId) : undefined;
  const inactive = new Set((clients ?? []).filter((c) => c.active === false).map((c) => c.id));
  const summary = competence
    ? monthSummary(
        all,
        empty,
        (tasks ?? []) as { client_id: string; document_type: DocumentType | null; status: TaskStatus; created_at: string }[],
        inactive,
      )
    : null;

  return (
    <>
      <PageHeader
        title="Downloads"
        description={
          drive
            ? "Notas baixadas pelo robô. Os arquivos ficam no Google Drive, na pasta JR Sistema - Notas\\ano\\mês\\cliente\\tipo."
            : "Notas baixadas pelo robô. Os arquivos ficam no computador que fez o download, em storage\\downloads\\ano\\mês\\cliente\\tipo."
        }
      />
      <Alert className="mb-4">
        {drive ? <Download /> : <FolderOpen />}
        <AlertDescription>
          {drive ? (
            <>
              <strong>Baixar</strong> baixa a nota do Google Drive, em qualquer computador: basta estar com a pasta{" "}
              <strong>JR Sistema - Notas</strong> compartilhada com você. O ícone de pasta abre o arquivo no computador
              onde o robô está instalado.
            </>
          ) : (
            <>
              O botão <strong>Abrir pasta</strong> funciona no computador onde o robô está instalado. Na primeira vez, o
              navegador pergunta se pode abrir o robô: marque <strong>“Sempre permitir”</strong> e clique em Abrir.
            </>
          )}
        </AlertDescription>
      </Alert>
      {drive ? (
        <BulkDownload
          target={bulkTarget(rows, competence, clientId)}
          competence={competence}
          clientName={client ? client.trade_name || client.legal_name : undefined}
        />
      ) : null}
      <ListCard>
        <ListToolbar>
        <ListFilters
          filters={[
            {
              name: "competence",
              placeholder: "Todas as competências",
              options: recentCompetences(24).map((c) => ({ value: c, label: formatCompetence(c) })),
            },
            {
              name: "client",
              placeholder: "Todos os clientes",
              width: "w-64",
              options: (clients ?? []).map((c) => ({ value: c.id, label: c.trade_name || c.legal_name })),
            },
            {
              name: "type",
              placeholder: "Todos os tipos",
              options: (Object.keys(DOCUMENT_LABEL) as DocumentType[]).map((d) => ({ value: d, label: DOCUMENT_LABEL[d] })),
            },
            {
              name: "situacao",
              placeholder: "Todas as situações",
              options: (Object.keys(SITUATION_LABEL) as Situation[]).map((s) => ({ value: s, label: SITUATION_LABEL[s] })),
            },
          ]}
        />
        <NotesToCheckLink count={toCheck} active={checking} href={hrefWith({ conferir: checking ? null : "1" })} />
        </ListToolbar>
        {competence && summary ? (
          <MonthSummaryBar competence={competence} summary={summary} hrefFor={(s) => hrefWith({ situacao: s })} />
        ) : null}
        <DownloadsTable rows={rows} empty={emptyRows} situation={situation} drive={drive} alerts={alerts} />
        <LoadMore
          shown={all.length + empty.length}
          total={total}
          step={PAGE}
          href={moreHref("/downloads", params, shown, PAGE)}
          noun={["item", "itens"]}
        />
      </ListCard>
    </>
  );
}
