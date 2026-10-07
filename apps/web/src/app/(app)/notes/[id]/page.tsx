import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { KindBadge } from "@/components/notes/notes-list";
import { NoteViewer } from "@/components/notes/note-viewer";
import { requireSession } from "@/lib/auth";
import { formatCompetence } from "@/lib/competence";
import { formatDoc, formatMoney } from "@/lib/danfe";
import { driveDownloadUrl } from "@/lib/downloads";
import { formatDateTime } from "@/lib/format";
import { formatKey } from "@/lib/nfe-key";
import { counterparty, NOTE_SELECT, noteKind } from "@/lib/notes";
import { createClient } from "@/lib/supabase/server";
import type { NoteRow } from "@/lib/types";

export const metadata: Metadata = { title: "Nota" };

export default async function NotePage({ params }: PageProps<"/notes/[id]">) {
  const { id } = await params;
  await requireSession();
  const supabase = await createClient();
  const { data } = await supabase.from("notes").select(NOTE_SELECT).eq("id", id).maybeSingle();
  if (!data) notFound();
  const note = data as NoteRow;
  const other = counterparty(note);
  const kind = noteKind(note);
  const clientName = note.clients?.trade_name || note.clients?.legal_name || "Cliente";

  return (
    <>
      <Link href="/notes" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Busca por chave de acesso
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {kind.label} nº {note.numero ?? "—"} · série {note.serie ?? "—"}
            </h1>
            <KindBadge note={note} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <Link href={`/clients/${note.client_id}`} className="font-medium text-foreground hover:underline">
              {clientName}
            </Link>{" "}
            · {formatCompetence(note.competence)} · emitida em {formatDateTime(note.emitida_em)} · {other.role.toLowerCase()}:{" "}
            {other.nome}
            {other.doc ? ` (${formatDoc(other.doc)})` : ""}
          </p>
          <p className="mt-1 font-mono text-xs text-(--c-6b6c66)">{formatKey(note.chave)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-(--c-6b6c66)">Valor da nota</p>
          <p className="font-mono text-xl font-semibold">R$ {formatMoney(note.valor)}</p>
        </div>
      </div>
      <NoteViewer note={note} driveUrl={driveDownloadUrl(note.downloads?.drive_file_id)} />
    </>
  );
}
