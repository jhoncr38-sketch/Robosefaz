import type { Metadata } from "next";

import { FaturamentoView } from "@/components/faturamento/faturamento-view";
import { HelpTip } from "@/components/list-extras";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { ALL_COMPANIES, type ResumoRow } from "@/lib/faturamento";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Faturamento" };

export default async function FaturamentoPage({ searchParams }: PageProps<"/faturamento">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  // as somas já estão prontas no banco (faturamento_resumo, uma linha por empresa e mês), com o RLS do próprio usuário
  const [{ data }, { data: resumo }] = await Promise.all([
    supabase.from("clients").select("id, client_code, trade_name, legal_name, cnpj").eq("active", true).order("trade_name").order("legal_name"),
    supabase
      .from("faturamento_resumo")
      .select("client_id, competence, saidas, entradas, prestados, tomados, notas, canceladas")
      .order("competence", { ascending: false })
      .limit(10000),
  ]);
  const clients = (
    (data ?? []) as {
      id: string;
      client_code: string;
      trade_name: string | null;
      legal_name: string;
      cnpj: string;
    }[]
  )
    .map((c) => ({
      id: c.id,
      client_code: c.client_code,
      name: c.trade_name || c.legal_name,
      cnpj: c.cnpj,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));

  const wanted = typeof params.empresa === "string" ? params.empresa : "";
  // sem escolha, a visão do escritório inteiro
  const selected = clients.some((c) => c.id === wanted) ? wanted : ALL_COMPANIES;

  return (
    <>
      <PageHeader
        title="Faturamento"
        description="Quanto cada empresa movimentou no mês, pelas notas já baixadas."
        help={
          <HelpTip>
            <p>
              <b>Total de saídas</b> (o faturamento) = NF-e emitidas + NFC-e + NFS-e prestadas. <b>Total de entradas</b> = NF-e recebidas + NFS-e tomadas. Em
              &ldquo;Todas as empresas&rdquo;, uma linha por empresa e a soma do escritório; clique no nome para ver só aquela empresa. Os valores vêm do índice
              das notas já baixadas, por mês de competência; notas canceladas ficam fora da soma e aparecem contadas.
            </p>
            <p>
              Sem o CFOP, as saídas incluem remessas, devoluções e transferências: use como visão geral do movimento, não como receita bruta para o Simples. O
              mês em andamento só mostra o que já foi baixado.
            </p>
          </HelpTip>
        }
      />
      {/* key: trocar de empresa recomeça o mês escolhido a partir da URL */}
      <FaturamentoView
        key={selected}
        clients={clients}
        selected={selected}
        rows={(resumo ?? []) as ResumoRow[]}
        initialMonth={typeof params.mes === "string" ? params.mes : ""}
      />
    </>
  );
}
