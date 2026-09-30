import type { Metadata } from "next";

import { MalhasBoard } from "@/components/malhas/malhas-board";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import type { MalhaCheckJob } from "@/lib/malhas";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { MalhaCheck } from "@/lib/types";

export const metadata: Metadata = { title: "Consulta de Malhas" };

export default async function MalhasPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [clients, checksRes, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase.from("malha_checks").select("*").limit(5000),
    supabase
      .from("automation_jobs")
      .select("id, client_id, status, created_at, last_message, error_message")
      .contains("operations", ["MALHA_CHECK"])
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  return (
    <>
      <PageHeader
        title="Consulta de Malhas"
        description="O robô lê no SIAT (Autoatendimento → Malhas Fiscais → Consulta de Malhas) as malhas em aberto de cada cliente: DIEF/PGDAS e EFD/OIE."
      />
      <MalhasBoard
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
        checks={(checksRes.data ?? []) as MalhaCheck[]}
        jobs={(jobsRes.data ?? []) as MalhaCheckJob[]}
      />
    </>
  );
}
