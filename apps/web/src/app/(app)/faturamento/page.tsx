import type { Metadata } from "next";

import { FaturamentoView } from "@/components/faturamento/faturamento-view";
import { HelpTip } from "@/components/list-extras";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { type MonthTotals, monthView } from "@/lib/faturamento";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Faturamento" };

export default async function FaturamentoPage({ searchParams }: PageProps<"/faturamento">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("id, client_code, trade_name, legal_name, cnpj").eq("active", true).order("trade_name").order("legal_name");
  const clients = ((data ?? []) as { id: string; client_code: string; trade_name: string | null; legal_name: string; cnpj: string }[])
    .map((c) => ({ id: c.id, client_code: c.client_code, name: c.trade_name || c.legal_name, cnpj: c.cnpj }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));

  const wanted = typeof params.empresa === "string" ? params.empresa : "";
  const selected = clients.some((c) => c.id === wanted) ? wanted : (clients[0]?.id ?? "");
  // as somas são feitas no banco (faturamento_mensal), com o RLS do próprio usuário
  const totals = selected ? await supabase.rpc("faturamento_mensal", { p_client_id: selected }) : { data: [] };
  const months = ((totals.data ?? []) as MonthTotals[]).map(monthView);

  return (
    <>
      <PageHeader
        title="Faturamento"
        description="Quanto cada empresa movimentou no mês, pelas notas já baixadas."
        help={
          <HelpTip>
            <p>
              Faturamento = <b>saídas</b> (NF-e emitidas e NFC-e) + <b>serviços prestados</b> (NFS-e). As entradas (NF-e
              recebidas) e os serviços tomados aparecem ao lado. Os valores vêm do índice das notas já baixadas, por mês
              de competência; notas canceladas ficam fora da soma e aparecem contadas.
            </p>
            <p>
              Sem o CFOP, as saídas incluem remessas, devoluções e transferências: use como visão geral do movimento, não
              como receita bruta para o Simples. O mês em andamento só mostra o que já foi baixado.
            </p>
          </HelpTip>
        }
      />
      <FaturamentoView clients={clients} selected={selected} months={months} initialMonth={typeof params.mes === "string" ? params.mes : ""} />
    </>
  );
}
