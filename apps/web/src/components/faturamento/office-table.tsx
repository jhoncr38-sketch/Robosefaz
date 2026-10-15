"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";

import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type FaturamentoClient,
  formatAmount,
  monthLabel,
  type MonthView,
  type OfficeColumn,
  officeColumns,
  officeMonth,
  type OfficeSide,
  type ResumoRow,
  type SortDir,
  type SortKey,
  sortForSide,
} from "@/lib/faturamento";
import { cn } from "@/lib/utils";

const SIDES: [OfficeSide, string][] = [
  ["tudo", "Tudo"],
  ["saidas", "Saídas"],
  ["entradas", "Entradas"],
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cell = (v: MonthView, key: OfficeColumn["key"]) => (key === "notas" ? String(v.notas) : formatAmount(v[key]));

/** Resultados › Faturamento › Todas as empresas: uma linha por empresa no mês e a soma do escritório. */
export function OfficeTable({
  clients,
  rows,
  competence,
  onPickCompany,
}: {
  clients: FaturamentoClient[];
  rows: ResumoRow[];
  competence: string;
  onPickCompany: (id: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "faturamento", dir: "desc" });
  // filtro de lado: tudo, só saídas e seu total, ou só entradas e seu total
  const [side, setSide] = useState<OfficeSide>("tudo");
  const [showParts, setShowParts] = useState(true);
  const data = officeMonth(clients, rows, competence, sort);
  const columns = officeColumns(side, showParts);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }

  function chooseSide(next: OfficeSide) {
    setSide(next);
    setSort((s) => sortForSide(next, s));
  }

  const SortIcon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  const head = (key: SortKey, label: string, className?: string) => (
    <TableHead
      key={key}
      className={cn("px-2.5 text-[11.5px] whitespace-nowrap", className)}
      aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 font-medium hover:text-foreground">
        {label}
        {sort.key === key ? <SortIcon className="size-3" /> : null}
      </button>
    </TableHead>
  );

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--c-efefeb) px-4 py-3">
        <h2 className="text-[15px] font-semibold">
          Todas as empresas
          <span className="ml-2 font-mono text-[12px] font-normal text-(--c-6b6c66)">{monthLabel(competence)}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-[7px] bg-(--c-f3f3f0) p-0.5" role="tablist" aria-label="Lado das notas">
            {SIDES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={side === key}
                onClick={() => chooseSide(key)}
                className={cn(
                  "rounded-[5px] px-2.5 py-[5px] text-xs whitespace-nowrap",
                  side === key ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={!showParts}
            onClick={() => setShowParts((v) => !v)}
            className="rounded-[7px] border border-input px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showParts ? "Só os totais" : "Mostrar as parcelas"}
          </button>
        </div>
      </div>

      <Table className="text-[12.5px]">
        <TableHeader>
          <TableRow>
            {head("name", "Empresa", "text-left")}
            {columns.map((c) => head(c.key, c.label, cn("text-right", c.total && "text-foreground")))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.companies.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="max-w-[300px] px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => onPickCompany(c.id)}
                  className="block max-w-full truncate text-left font-medium hover:underline"
                  title={`${c.client_code} · abrir só esta empresa`}
                >
                  {c.name}
                </button>
              </TableCell>
              {c.view ? (
                columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn("px-2.5 py-2 text-right whitespace-nowrap tabular-nums", col.part && "text-(--c-6b6c66)", col.total && "font-semibold")}
                  >
                    {cell(c.view as MonthView, col.key)}
                  </TableCell>
                ))
              ) : (
                <TableCell colSpan={columns.length} className="px-2.5 py-2 text-[12px] text-muted-foreground">
                  sem notas baixadas neste mês
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
        {data.withNotes > 0 ? (
          <TableFooter>
            <TableRow>
              <TableCell className="px-2.5 py-2.5 font-semibold whitespace-nowrap">Total do escritório</TableCell>
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn("px-2.5 py-2.5 text-right font-semibold whitespace-nowrap tabular-nums", col.part && "font-medium text-(--c-6b6c66)")}
                >
                  {cell(data.total, col.key)}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>

      <p className="border-t border-(--c-efefeb) px-4 py-2.5 text-[12.5px] text-(--c-6b6c66)">
        {data.withNotes === 0
          ? `Nenhuma empresa tem nota baixada em ${monthLabel(competence)}.`
          : `${plural(data.withNotes, "empresa com notas", "empresas com notas")} em ${monthLabel(competence)}`}
        {data.withoutNotes ? ` · ${plural(data.withoutNotes, "sem notas baixadas", "sem notas baixadas")}` : ""}
        {data.total.canceladas ? ` · ${plural(data.total.canceladas, "cancelada fora da soma", "canceladas fora da soma")}` : ""}
        {data.withNotes ? " · valores em R$" : ""}
      </p>
    </section>
  );
}
