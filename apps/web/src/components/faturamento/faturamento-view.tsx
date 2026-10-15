"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SearchSelect } from "@/components/nfse/search-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCNPJ } from "@/lib/cnpj";
import { formatBRL, monthLabel, type MonthView, pickMonth } from "@/lib/faturamento";

export interface FaturamentoClient {
  id: string;
  client_code: string;
  name: string;
  cnpj: string;
}

/** Resultados › Faturamento: a pessoa escolhe a empresa e o mês e vê o faturamento com as quatro parcelas. */
export function FaturamentoView({
  clients,
  selected,
  months,
  initialMonth,
}: {
  clients: FaturamentoClient[];
  selected: string;
  /** meses da empresa escolhida, do mais recente ao mais antigo */
  months: MonthView[];
  initialMonth: string;
}) {
  const router = useRouter();
  const [month, setMonth] = useState(() => pickMonth(months, initialMonth));
  const client = clients.find((c) => c.id === selected) ?? null;
  const view = months.find((m) => m.competence === month) ?? null;

  function chooseClient(id: string) {
    router.push(`/faturamento?empresa=${id}`);
  }

  function chooseMonth(value: string) {
    setMonth(value);
    router.replace(`/faturamento?empresa=${selected}&mes=${value}`, { scroll: false });
  }

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="flex max-w-[900px] flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {/* lista com busca: digita parte do nome, do código ou do CNPJ */}
        <div className="flex w-[360px] max-w-full flex-col gap-1 text-xs font-medium text-(--c-6b6c66)">
          Empresa
          <SearchSelect
            label="Empresa"
            value={selected}
            options={clients.map((c) => ({ value: c.id, label: c.name, hint: `${c.client_code} · ${formatCNPJ(c.cnpj)}` }))}
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
                <SelectItem key={m.competence} value={m.competence}>
                  {monthLabel(m.competence)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <section className="rounded-xl border bg-card px-5 py-4 shadow-card">
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
            </p>
          </>
        )}
      </section>
    </div>
  );
}
