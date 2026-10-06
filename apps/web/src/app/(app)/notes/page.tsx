import { Receipt } from "lucide-react";
import type { Metadata } from "next";

import { ListCard } from "@/components/data-list";
import { HelpTip } from "@/components/list-extras";
import { NotesList } from "@/components/notes/notes-list";
import { NotesSearch } from "@/components/notes/notes-search";
import { EmptyState, PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { parseNoteQuery } from "@/lib/nfe-key";
import { NOTE_LIST_SELECT } from "@/lib/notes";
import { createClient } from "@/lib/supabase/server";
import type { NoteRow } from "@/lib/types";

export const metadata: Metadata = { title: "Notas" };

const NUM = new Intl.NumberFormat("pt-BR");

export default async function NotesPage({ searchParams }: PageProps<"/notes">) {
  await requireSession();
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
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
  }

  const [{ count: total }, { count: indexed }, { count: pending }] = await Promise.all([
    supabase.from("notes").select("id", { count: "exact", head: true }),
    supabase.from("downloads").select("id", { count: "exact", head: true }).not("notes_indexed_at", "is", null),
    supabase.from("downloads").select("id", { count: "exact", head: true }).is("notes_indexed_at", null),
  ]);

  return (
    <>
      <PageHeader
        title="Notas"
        help={
          <HelpTip>
            <p>
              O robô lê cada XML dos ZIPs baixados e guarda número, chave, data, valor, emitente e destinatário. Aqui você
              acha uma nota pelo <b>número</b>, pela <b>chave de acesso</b>, pelo <b>CNPJ/CPF</b> da outra parte ou pelo nome.
            </p>
            <p>
              Ao abrir uma nota, o robô separa o XML dela de dentro do ZIP e o painel monta a visualização no formato da
              DANFE. Só aparecem notas que já foram baixadas do SIAT.
            </p>
          </HelpTip>
        }
      />
      <ListCard>
        <NotesSearch q={q} />
        {!query ? (
          <EmptyState
            icon={<Receipt />}
            title="Busque uma nota"
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
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Receipt />}
            title={`Nenhuma nota encontrada para “${q}”`}
            description={
              query.kind === "numero"
                ? "Só aparecem notas já baixadas do SIAT. Confira o número ou tente pela chave de acesso."
                : "Só aparecem notas já baixadas do SIAT. Confira o que foi digitado."
            }
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
