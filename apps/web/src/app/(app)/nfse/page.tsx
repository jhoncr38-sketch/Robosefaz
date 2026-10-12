import type { Metadata } from "next";

import { HelpTip } from "@/components/list-extras";
import { AdnDelayCard } from "@/components/nfse/adn-delay-card";
import { NfseBoard } from "@/components/nfse/nfse-board";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { MUNICIPIOS } from "@/lib/ibge-municipios";
import type { NfseCursor, NfseJob } from "@/lib/nfse";
import { type AdnDelayRow, delayNotices, monthBounds, monthClosing, monthCovered, type MonthArrivalRow, previousMonth } from "@/lib/nfse-atraso";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "NFS-e Nacional" };

export default async function NfsePage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  // o mês que o escritório está fechando: o anterior ao de hoje
  const month = previousMonth(new Date());
  const bounds = monthBounds(month);
  // todas as NFS-e do mês, para saber se a hora de chegada cobre o mês inteiro
  const monthNotes = () =>
    supabase.from("notes").select("id", { count: "exact", head: true }).in("document_type", ["NFSE_PRESTADAS", "NFSE_TOMADAS"]).gte("emitida_em", bounds.start).lt("emitida_em", bounds.end);
  const [clients, cursorsRes, jobsRes, delayRes, monthRes, monthTotal, monthArrived] = await Promise.all([
    loadPlannerClients(),
    supabase.from("nfse_cursors").select("client_id, last_nsu, fetched_at, last_documents").limit(5000),
    supabase
      .from("automation_jobs")
      .select("id, client_id, status, created_at, finished_at, last_message, error_message")
      .contains("operations", ["NFSE_FETCH"])
      .order("created_at", { ascending: false })
      .limit(2000),
    // quanto cada prefeitura levou para repassar as notas que chegaram nos últimos 30 dias (só NFS-e)
    supabase.rpc("nfse_adn_delay", { p_days: 30 }),
    // as NFS-e do mês anterior geradas pelo sistema da prefeitura, com a hora em que chegaram ao ambiente nacional
    supabase
      .from("notes")
      .select("c_loc_emi, adn_recebida_em")
      .in("document_type", ["NFSE_PRESTADAS", "NFSE_TOMADAS"])
      .eq("amb_ger", 1)
      .not("adn_recebida_em", "is", null)
      .gte("emitida_em", bounds.start)
      .lt("emitida_em", bounds.end)
      .limit(5000),
    monthNotes(),
    monthNotes().not("adn_recebida_em", "is", null),
  ]);
  const delays = delayNotices((delayRes.data ?? []) as AdnDelayRow[], (code) => MUNICIPIOS[code]);
  const activeIds = new Set(clients.filter((c) => c.active).map((c) => c.id));
  const searches = ((cursorsRes.data ?? []) as NfseCursor[]).filter((c) => activeIds.has(c.client_id)).map((c) => c.fetched_at);
  const closings = monthCovered(monthTotal.count ?? 0, monthArrived.count ?? 0) ? monthClosing((monthRes.data ?? []) as MonthArrivalRow[], month, searches) : {};

  return (
    <>
      <PageHeader
        title="NFS-e Nacional"
        help={
          <HelpTip>
            <p>
              O robô consulta a <b>NFS-e Nacional</b> (Ambiente de Dados Nacional) com o certificado de cada cliente e
              traz as notas de serviço em que ele é <b>prestador</b> ou <b>tomador</b>. Não abre navegador e só lê: nada
              é emitido ou cancelado.
            </p>
            <p>
              Cada busca continua de onde a anterior parou e traz tudo o que é novo, de qualquer mês. As notas vão para
              a pasta das notas (ano/mês/empresa, &ldquo;NFS-e prestadas&rdquo; e &ldquo;NFS-e tomadas&rdquo;) e
              aparecem em Downloads e na busca por chave. Cancelamentos marcam a nota.
            </p>
          </HelpTip>
        }
      />
      <AdnDelayCard notices={delays} month={month} closings={closings} />
      <NfseBoard
        canRun={can(profile.role, "automation:run")}
        clients={clients
          .filter((c) => c.active)
          .map((c) => ({
            id: c.id,
            client_code: c.client_code,
            name: c.trade_name || c.legal_name,
            legal_name: c.legal_name,
            cnpj: c.cnpj,
            certificate_ok: c.certificate_status === "valid" || c.certificate_status === "expiring",
          }))}
        cursors={(cursorsRes.data ?? []) as NfseCursor[]}
        jobs={(jobsRes.data ?? []) as NfseJob[]}
      />
    </>
  );
}
