import { Receipt } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ListCard } from "@/components/data-list";
import { HelpTip } from "@/components/list-extras";
import { KeyInsightCard, type LastSearch } from "@/components/notes/key-insight";
import { NoteSearchProgress, type NoteSearchJob } from "@/components/notes/note-search-progress";
import { NotesBetaNotice } from "@/components/notes/notes-beta-notice";
import { NotesList } from "@/components/notes/notes-list";
import { NotesSearch } from "@/components/notes/notes-search";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { lookupCnpj } from "@/lib/cnpj-lookup";
import { buildKeyInsight, type InsightClient, type KeyInsight } from "@/lib/key-insight";
import { parseNoteQuery } from "@/lib/nfe-key";
import { NOTE_LIST_SELECT } from "@/lib/notes";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { JobStatus, NoteRow } from "@/lib/types";

export const metadata: Metadata = { title: "Busca por chave de acesso" };

const NUM = new Intl.NumberFormat("pt-BR");
const FINAL: JobStatus[] = ["completed", "failed", "cancelled"];

type KeyJobRow = {
  id: string;
  status: JobStatus;
  last_message: string | null;
  error_message: string | null;
  created_at: string;
  client_id: string;
  clients: { legal_name: string; trade_name: string | null } | null;
};

export default async function NotesPage({ searchParams }: PageProps<"/notes">) {
  const { profile } = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const actionError = typeof params.erro === "string" ? params.erro : null;
  const query = parseNoteQuery(q);
  const supabase = await createClient();

  let rows: NoteRow[] = [];
  if (query) {
    let req = supabase.from("notes").select(NOTE_LIST_SELECT).order("emitida_em", { ascending: false, nullsFirst: false }).limit(200);
    switch (query.kind) {
      case "chave":
        req = req.eq("chave", query.value);
        break;
      case "numero":
        req = req.eq("numero", query.value);
        break;
      case "documento":
        req = req.or(`dest_doc.eq.${query.value},emit_doc.eq.${query.value}`);
        break;
      case "nome":
        req = req.or(`dest_nome.ilike.%${query.value}%,emit_nome.ilike.%${query.value}%`);
        break;
    }
    const { data } = await req;
    rows = (data ?? []) as unknown as NoteRow[];
    // chave que já está nos arquivos: vai direto para a nota (DANFE e XML), sem passar pela lista;
    // a lista só aparece se a mesma nota existir em mais de uma empresa (emitente e destinatário clientes)
    if (query.kind === "chave" && rows.length === 1) redirect(`/notes/${rows[0].id}`);
  }

  // chave que não está nos arquivos: o que ela revela, com que empresa buscar no SIAT e se o
  // robô já está (ou esteve) buscando
  let insight: KeyInsight | null = null;
  let emitter: { nome: string; cidade: string } | null = null;
  let activeJob: NoteSearchJob | null = null;
  let lastSearch: LastSearch | null = null;
  if (query?.kind === "chave" && rows.length === 0) {
    const cnpj = query.value.slice(6, 20);
    const competence = `20${query.value.slice(2, 4)}-${query.value.slice(4, 6)}`;
    const [clientsRes, recipientsRes, downloadedRes, jobRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, client_code, legal_name, trade_name, cnpj, uses_nfe_received, uses_nfe_issued, uses_nfce")
        .eq("active", true)
        .order("legal_name"),
      supabase.from("notes").select("client_id, emit_nome").eq("emit_doc", cnpj).limit(2000),
      supabase.from("downloads").select("client_id").eq("competence", competence).eq("document_type", "NFE_RECEBIDAS").limit(2000),
      supabase
        .from("automation_jobs")
        .select("id, status, last_message, error_message, created_at, client_id, clients(legal_name, trade_name)")
        .eq("note_key", query.value)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const clients: InsightClient[] = (clientsRes.data ?? []).map((c) => ({
      id: c.id,
      client_code: c.client_code,
      name: c.trade_name || c.legal_name,
      cnpj: c.cnpj,
      uses_nfe_received: c.uses_nfe_received,
      uses_nfe_issued: c.uses_nfe_issued,
      uses_nfce: c.uses_nfce,
    }));
    insight = buildKeyInsight(
      query.value,
      clients,
      new Set((recipientsRes.data ?? []).map((r) => r.client_id as string)),
      new Set((downloadedRes.data ?? []).map((r) => r.client_id as string)),
    );
    const known = (recipientsRes.data ?? []).find((r) => r.emit_nome)?.emit_nome as string | undefined;
    if (insight && !insight.emitClient) emitter = known ? { nome: known, cidade: "" } : await lookupCnpj(cnpj);

    const job = jobRes.data as unknown as KeyJobRow | null;
    if (job) {
      const clientName = job.clients?.trade_name || job.clients?.legal_name || "a empresa escolhida";
      if (FINAL.includes(job.status)) {
        lastSearch = {
          id: job.id,
          status: job.status as LastSearch["status"],
          clientId: job.client_id,
          clientName,
          message: job.status === "completed" ? job.last_message : (job.error_message ?? job.last_message),
        };
      } else {
        activeJob = {
          id: job.id,
          status: job.status,
          last_message: job.last_message,
          error_message: job.error_message,
          created_at: job.created_at,
          clientName,
        };
      }
    }
  }

  const [{ count: total }, { count: indexed }, { count: pending }] = await Promise.all([
    supabase.from("notes").select("id", { count: "exact", head: true }),
    supabase.from("downloads").select("id", { count: "exact", head: true }).not("notes_indexed_at", "is", null),
    supabase.from("downloads").select("id", { count: "exact", head: true }).is("notes_indexed_at", null),
  ]);

  return (
    <>
      {/* fase beta: o aviso aparece toda vez que a tela é aberta pelo menu (sem chave na busca) */}
      {!query ? <NotesBetaNotice /> : null}
      <PageHeader
        title="Busca por chave de acesso"
        help={
          <HelpTip>
            <p>
              Cole a <b>chave de acesso</b> da nota (os 44 números da DANFE). O robô lê cada XML dos ZIPs baixados e
              guarda a chave, o número, a data, o valor, o emitente e o destinatário; se a nota já foi baixada, ela
              aparece na hora.
            </p>
            <p>
              Ao abrir uma nota, o robô separa o XML dela de dentro do ZIP e o painel monta a visualização no formato da
              DANFE. Se a nota ainda não foi baixada, você escolhe a empresa e o robô entra no SIAT com o certificado
              dela para exportar só essa nota.
            </p>
          </HelpTip>
        }
      />
      <ListCard>
        <NotesSearch q={q} />
        {!query ? (
          <EmptyState
            icon={<Receipt />}
            title="Busque uma nota pela chave de acesso"
            description={
              (total ?? 0) > 0
                ? `${NUM.format(total ?? 0)} notas de ${NUM.format(indexed ?? 0)} arquivo(s) já estão no índice.${
                    (pending ?? 0) > 0 ? ` O robô ainda vai ler ${NUM.format(pending ?? 0)} arquivo(s).` : ""
                  }`
                : (pending ?? 0) > 0
                  ? `O robô está lendo ${NUM.format(pending ?? 0)} arquivo(s); a busca fica disponível em alguns minutos.`
                  : "Nenhuma nota baixada ainda."
            }
          />
        ) : rows.length === 0 && insight && activeJob ? (
          <div className="px-4 py-5">
            <NoteSearchProgress job={activeJob} chave={insight.key} />
          </div>
        ) : rows.length === 0 && insight ? (
          <KeyInsightCard
            insight={insight}
            emitter={emitter}
            canRun={can(profile.role, "automation:run")}
            lastSearch={lastSearch}
            error={actionError}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Receipt />}
            title={`Nenhuma nota encontrada para “${q}”`}
            description="Nenhuma nota baixada combina com isso. Cole a chave de acesso completa (44 números) para buscar a nota, inclusive no SIAT."
          />
        ) : (
          <>
            <NotesList rows={rows} />
            <p className="border-t border-(--c-efefeb) px-4 py-2.5 text-center text-xs text-(--c-6b6c66)">
              {rows.length === 1 ? "1 nota encontrada." : `${rows.length} notas encontradas${rows.length === 200 ? " (mostrando as 200 mais recentes)" : ""}.`}
            </p>
          </>
        )}
      </ListCard>
    </>
  );
}
