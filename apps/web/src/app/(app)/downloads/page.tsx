import { Download, FolderOpen } from "lucide-react";
import type { Metadata } from "next";

import { BulkDownload } from "@/components/bulk-download";
import { ListCard, ListToolbar } from "@/components/data-list";
import { DownloadsTable, NotesToCheckLink } from "@/components/downloads-table";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requireSession } from "@/lib/auth";
import { formatCompetence, recentCompetences } from "@/lib/competence";
import { bulkTarget, notesInGoogleDrive } from "@/lib/downloads";
import { type NoteCountRow, noteAlerts } from "@/lib/note-count";
import { DOCUMENT_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { DocumentType, DownloadRow } from "@/lib/types";

export const metadata: Metadata = { title: "Downloads" };

export default async function DownloadsPage({ searchParams }: PageProps<"/downloads">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("downloads")
    .select("*, clients(client_code, legal_name, trade_name, cnpj)")
    .order("downloaded_at", { ascending: false })
    .limit(500);
  if (typeof params.competence === "string") query = query.eq("competence", params.competence);
  if (typeof params.client === "string") query = query.eq("client_id", params.client);
  if (typeof params.type === "string") query = query.eq("document_type", params.type);

  const [{ data }, { data: clients }, drive, { data: counted }] = await Promise.all([
    query,
    supabase.from("clients").select("id, legal_name, trade_name").order("legal_name"),
    notesInGoogleDrive(supabase),
    // meses anteriores de cada cliente e tipo, para o aviso de mês "estranho" (poucos bytes por linha)
    supabase
      .from("downloads")
      .select("id, client_id, document_type, competence, note_count, downloaded_at")
      .not("note_count", "is", null)
      .limit(10000),
  ]);
  const all = (data ?? []) as DownloadRow[];
  const alerts = noteAlerts(all, (counted ?? []) as NoteCountRow[]);
  const checking = params.conferir === "1";
  const rows = checking ? all.filter((d) => alerts[d.id]) : all;
  const toCheck = all.filter((d) => alerts[d.id]).length;
  const withoutCheck = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "conferir"),
  );
  const checkHref = (on: boolean) => {
    const q = new URLSearchParams(withoutCheck);
    if (on) q.set("conferir", "1");
    return q.size ? `/downloads?${q}` : "/downloads";
  };
  const competence = typeof params.competence === "string" ? params.competence : undefined;
  const clientId = typeof params.client === "string" ? params.client : undefined;
  const client = (clients ?? []).find((c) => c.id === clientId);

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
          ]}
        />
        <NotesToCheckLink count={toCheck} active={checking} href={checkHref(!checking)} />
        </ListToolbar>
        <DownloadsTable rows={rows} drive={drive} alerts={alerts} />
      </ListCard>
    </>
  );
}
