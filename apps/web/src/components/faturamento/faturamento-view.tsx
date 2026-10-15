"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { OfficeTable } from "@/components/faturamento/office-table";
import { SearchSelect } from "@/components/nfse/search-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCNPJ } from "@/lib/cnpj";
import { ALL_COMPANIES, type FaturamentoClient, formatBRL, monthLabel, monthsOf, monthView, pickCompetence, type ResumoRow } from "@/lib/faturamento";

export type { FaturamentoClient } from "@/lib/faturamento";

/**
 * Resultados › Faturamento: a pessoa escolhe "Todas as empresas" (uma linha por empresa, com os dois totais e a
 * soma do escritório) ou uma empresa (os cartões do mês), e o mês. As somas vêm prontas de faturamento_resumo.
 */
export function FaturamentoView({
  clients,
  selected,
  rows,
  initialMonth,
}: {
  clients: FaturamentoClient[];
  /** id da empresa ou ALL_COMPANIES */
  selected: string;
  /** todas as linhas do resumo que o usuário enxerga (empresa x mês) */
  rows: ResumoRow[];
  initialMonth: string;
}) {
  const router = useRouter();
  const all = selected === ALL_COMPANIES;
  const client = all ? null : (clients.find((c) => c.id === selected) ?? null);
  const own = all ? rows : rows.filter((r) => r.client_id === selected);
  const months = monthsOf(own);
  const [month, setMonth] = useState(() => pickCompetence(months, initialMonth));
  const view = client ? (own.filter((r) => r.competence === month).map(monthView)[0] ?? null) : null;

  function chooseClient(id: string) {
    router.push(`/faturamento?empresa=${id}${month ? `&mes=${month}` : ""}`);
  }

  function chooseMonth(value: string) {
    setMonth(value);
    router.replace(`/faturamento?empresa=${selected}&mes=${value}`, {
      scroll: false,
    });
  }

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="flex max-w-[1040px] flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {/* lista com busca: "Todas as empresas" no topo; depois digita parte do nome, do código ou do CNPJ */}
        <div className="flex w-[360px] max-w-full flex-col gap-1 text-xs font-medium text-(--c-6b6c66)">
          Empresa
          <SearchSelect
            label="Empresa"
            value={selected}
            options={[
              {
                value: ALL_COMPANIES,
                label: "Todas as empresas",
                hint: "visão do escritório",
              },
              ...clients.map((c) => ({
                value: c.id,
                label: c.name,
                hint: `${c.client_code} · ${formatCNPJ(c.cnpj)}`,
              })),
            ]}
            onChange={chooseClient}
            placeholder="Escolha a empresa"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium text-(--c-6b6c66)">
          Mês
          <Select value={month} onValueChange={chooseMonth} disabled={months.length === 0}>
            <SelectTrigger className="w-40 bg-card">
              <SelectValue placeholder={months.length ? "MM/AAAA" : "Sem notas"} />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {all ? (
        months.length === 0 ? (
          <section className="rounded-xl border bg-card px-5 py-4 shadow-card">
            <p className="text-[13.5px] text-muted-foreground">
              Nenhuma empresa tem nota no índice ainda. Busque as notas em Executar automações ou NFS-e Nacional.
            </p>
          </section>
        ) : (
          <OfficeTable clients={clients} rows={rows} competence={month} onPickCompany={chooseClient} />
        )
      ) : (
        <section className="max-w-[900px] rounded-xl border bg-card px-5 py-4 shadow-card">
          {!client ? (
            <p className="text-[13.5px] text-muted-foreground">Escolha a empresa para ver o faturamento.</p>
          ) : !view ? (
            <p className="text-[13.5px] text-muted-foreground">
              {client.name} ainda não tem nota no índice. Busque as notas dela em Executar automações ou NFS-e Nacional.
            </p>
          ) : (
            <>
              <h2 className="text-[15px] font-semibold">
                {client.name}
                <span className="ml-2 font-mono text-[12px] font-normal text-(--c-6b6c66)">
                  {client.client_code} · {monthLabel(view.competence)}
                </span>
              </h2>
              <div className="mt-3.5 mb-4 rounded-[10px] border border-(--c-dcefe3) bg-(--c-f3faf6) px-4 py-3.5">
                <span className="block text-[11.5px] font-semibold tracking-[0.04em] text-(--c-17603b) uppercase">Faturamento do mês</span>
                <span className="text-[28px] font-bold tracking-[-0.02em] tabular-nums">{formatBRL(view.faturamento)}</span>
                <span className="mt-0.5 block text-[12px] text-(--c-6b6c66)">saídas + serviços prestados</span>
              </div>
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
                {(
                  [
                    ["Saídas (NF-e emitidas + NFC-e)", view.saidas],
                    ["Serviços prestados (NFS-e)", view.prestados],
                    ["Entradas (NF-e recebidas)", view.entradas],
                    ["Serviços tomados (NFS-e)", view.tomados],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded-[10px] border border-(--c-efefeb) px-3 py-2.5">
                    <span className="block text-[12px] font-medium text-(--c-6b6c66)">{label}</span>
                    <span className="text-[17px] font-semibold tabular-nums">{formatBRL(value)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3.5 text-[12.5px] text-(--c-6b6c66)">
                {plural(view.notas, "nota somada", "notas somadas")}
                {view.canceladas ? ` · ${plural(view.canceladas, "cancelada fora da soma", "canceladas fora da soma")}` : ""}.
                <button type="button" onClick={() => chooseClient(ALL_COMPANIES)} className="ml-2 text-(--c-17603b) hover:underline">
                  Ver todas as empresas neste mês
                </button>
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
