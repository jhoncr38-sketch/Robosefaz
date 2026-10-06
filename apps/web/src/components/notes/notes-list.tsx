import { ListHead, ListRow } from "@/components/data-list";
import { formatCompetence } from "@/lib/competence";
import { formatDoc, formatMoney } from "@/lib/danfe";
import { formatDateTime } from "@/lib/format";
import { counterparty, noteKind } from "@/lib/notes";
import type { NoteRow } from "@/lib/types";
import { cn } from "@/lib/utils";

// no celular: cliente e valor; o resto em telas maiores
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1.5fr)_130px_120px_130px_minmax(0,1.3fr)_120px]";

export function KindBadge({ note }: { note: Pick<NoteRow, "document_type" | "canceled"> }) {
  const kind = noteKind(note);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-xs whitespace-nowrap text-(--c-4a4b46)">{kind.label}</span>
      {kind.canceled ? (
        <span className="rounded bg-(--c-fdecec) px-1 py-px text-[10.5px] font-medium whitespace-nowrap text-(--c-b42323)">cancelada</span>
      ) : null}
    </span>
  );
}

export function NotesList({ rows }: { rows: NoteRow[] }) {
  return (
    <>
      <ListHead grid={GRID}>
        <span>Cliente</span>
        <span className="hidden md:block">Tipo</span>
        <span className="hidden md:block">Número</span>
        <span className="hidden md:block">Emissão</span>
        <span className="hidden md:block">Outra parte</span>
        <span className="text-right">Valor</span>
      </ListHead>
      {rows.map((n) => {
        const other = counterparty(n);
        return (
          <ListRow key={n.id} grid={GRID} href={`/notes/${n.id}`}>
            <div className="flex min-w-0 flex-col gap-px">
              <span className="truncate text-[13px] font-medium">{n.clients?.trade_name || n.clients?.legal_name || "—"}</span>
              <span className="truncate text-[11.5px] text-(--c-6b6c66)">
                <span className="font-mono">{n.clients?.client_code}</span> · {formatCompetence(n.competence)}
                <span className="md:hidden">
                  {" "}
                  · nº {n.numero ?? "—"} · {noteKind(n).label}
                </span>
              </span>
            </div>
            <div className="hidden md:block">
              <KindBadge note={n} />
            </div>
            <span className="hidden font-mono text-[12.5px] md:block">
              {n.numero ?? "—"} <span className="text-[11px] text-(--c-6b6c66)">série {n.serie ?? "—"}</span>
            </span>
            <span className="hidden font-mono text-xs text-(--c-4a4b46) md:block">{formatDateTime(n.emitida_em)}</span>
            <div className="hidden min-w-0 flex-col gap-px md:flex">
              <span className="truncate text-[13px]" title={other.nome}>
                {other.nome}
              </span>
              <span className="truncate font-mono text-[11px] text-(--c-6b6c66)">
                {other.role} · {formatDoc(other.doc) || "—"}
              </span>
            </div>
            <span className={cn("text-right font-mono text-[13px] font-semibold", noteKind(n).canceled && "text-(--c-6b6c66) line-through")}>
              R$ {formatMoney(n.valor)}
            </span>
          </ListRow>
        );
      })}
    </>
  );
}
