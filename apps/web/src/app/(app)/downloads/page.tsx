import type { Metadata } from "next";

import { DownloadsMonth, type MonthTab } from "@/components/downloads-month";
import { HelpTip } from "@/components/list-extras";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { currentCompetence, previousCompetence, shiftCompetence, toCompetenceKey } from "@/lib/competence";
import { bulkTarget, notesInGoogleDrive } from "@/lib/downloads";
import { monthClients, typeFilterFromDoc } from "@/lib/downloads-month";
import { asZeroCount, type NoMovementRow } from "@/lib/no-movement";
import { type NoteCountRow, noteAlerts } from "@/lib/note-count";
import { createClient } from "@/lib/supabase/server";
import type { DocumentType, DownloadRow, TaskStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Downloads" };

const EXPORTS = [
  "NFCE_EXPORT",
  "NFE_ISSUED_EXPORT",
  "NFE_RECEIVED_EXPORT",
  "NFCE_CANCELED_EXPORT",
  "NFE_ISSUED_CANCELED_EXPORT",
  "NFE_RECEIVED_CANCELED_EXPORT",
];

/** Aba pela URL antiga (?situacao=com-notas, ?conferir=1). */
function tabFrom(params: Record<string, string | string[] | undefined>): MonthTab {
  if (params.conferir === "1") return "conf";
  if (params.situacao === "com-notas") return "com";
  if (params.situacao === "sem-movimento") return "sem";
  return "all";
}

export default async function DownloadsPage({ searchParams }: PageProps<"/downloads">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  // uma competência por vez (‹ 09/2026 ›); o padrão é o mês que está sendo processado
  const asked = typeof params.competence === "string" ? toCompetenceKey(params.competence) : null;
  const competence = asked && asked <= currentCompetence() ? asked : previousCompetence();

  const [files, { data: clients }, drive, { data: counted }, empty, { data: emptyHistory }, { data: tasks }] = await Promise.all([
    supabase
      .from("downloads")
      .select("*, clients(client_code, legal_name, trade_name, cnpj)")
      .eq("competence", competence)
      .order("downloaded_at", { ascending: false })
      .limit(5000),
    supabase.from("clients").select("id, client_code, legal_name, trade_name, cnpj, active").order("legal_name"),
    notesInGoogleDrive(supabase),
    // meses anteriores de cada cliente e tipo, para o aviso de mês "para conferir"
    supabase
      .from("downloads")
      .select("id, client_id, document_type, competence, note_count, downloaded_at")
      .not("note_count", "is", null)
      .limit(10000),
    // processados sem notas (sem arquivo): uma linha por cliente, mês e tipo
    supabase.from("downloads_no_movement").select("*").eq("competence", competence).limit(5000),
    // todos os "sem movimento" (poucos campos), para o aviso de mês "para conferir"
    supabase.from("downloads_no_movement").select("id, client_id, job_id, competence, document_type, checked_at").limit(10000),
    // pedidos do mês: quem ainda não teve resposta da SEFAZ
    supabase
      .from("automation_tasks")
      .select("client_id, document_type, status, created_at")
      .in("task_type", EXPORTS)
      .eq("competence", competence)
      .limit(5000),
  ]);

  const monthFiles = (files.data ?? []) as DownloadRow[];
  const monthEmpty = (empty.data ?? []) as NoMovementRow[];
  // "sem movimento" conta como mês com 0 notas no aviso
  const alerts = noteAlerts(
    [...monthFiles, ...monthEmpty.map(asZeroCount)],
    [...((counted ?? []) as NoteCountRow[]), ...((emptyHistory ?? []) as NoMovementRow[]).map(asZeroCount)],
  );
  const rows = monthClients(
    monthFiles,
    monthEmpty,
    (tasks ?? []) as { client_id: string; document_type: DocumentType | null; status: TaskStatus; created_at: string }[],
    clients ?? [],
    alerts,
  );
  const target = drive ? bulkTarget(monthFiles, competence, undefined) : null;

  const prev = shiftCompetence(competence, -1);
  const next = shiftCompetence(competence, 1);
  const clientId = typeof params.client === "string" ? params.client : undefined;
  const initialQuery = clientId ? ((clients ?? []).find((c) => c.id === clientId)?.client_code ?? "") : "";

  return (
    <>
      <PageHeader
        title="Downloads"
        help={
          <HelpTip>
            {drive ? (
              <p>
                As notas ficam no Google Drive, na pasta <b>JR Sistema - Notas</b> › ano › mês › cliente › tipo. O botão de
                baixar pega a nota do Drive em qualquer computador com essa pasta compartilhada.
              </p>
            ) : (
              <p>
                As notas ficam no computador do robô, em storage\downloads\ano\mês\cliente\tipo. O ícone de pasta abre o
                arquivo nesse computador (na primeira vez, marque “Sempre permitir”).
              </p>
            )}
            <p>
              <b>Sem movimento:</b> o SIAT processou o pedido e não havia nota no período. <b>Para conferir:</b> mês sem
              notas ou com bem menos notas que a média dos meses anteriores.
            </p>
          </HelpTip>
        }
      />
      <DownloadsMonth
        key={competence}
        rows={rows}
        competence={competence}
        prevHref={prev ? `/downloads?competence=${prev}` : null}
        nextHref={next && next <= currentCompetence() ? `/downloads?competence=${next}` : null}
        drive={drive}
        monthFolder={target ? { url: target.folderUrl, files: target.files, clients: target.clients } : null}
        initialType={typeFilterFromDoc(params.type)}
        initialTab={tabFrom(params)}
        initialQuery={initialQuery}
      />
    </>
  );
}
