import type { Metadata } from "next";

import { HelpTip } from "@/components/list-extras";
import { NfseBoard } from "@/components/nfse/nfse-board";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import type { NfseCursor, NfseJob } from "@/lib/nfse";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "NFS-e Nacional" };

export default async function NfsePage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [clients, cursorsRes, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase.from("nfse_cursors").select("client_id, last_nsu, fetched_at, last_documents").limit(5000),
    supabase
      .from("automation_jobs")
      .select("id, client_id, status, created_at, finished_at, last_message, error_message")
      .contains("operations", ["NFSE_FETCH"])
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

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
