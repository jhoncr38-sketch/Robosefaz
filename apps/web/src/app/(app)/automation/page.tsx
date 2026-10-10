import type { Metadata } from "next";

import { AutomationScheduler } from "@/components/automation/automation-scheduler";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { currentCompetence, previousCompetence, toCompetenceKey } from "@/lib/competence";
import { plannerStatusMap } from "@/lib/competence-status";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { JobStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Executar automações" };

export default async function AutomationPage({ searchParams }: PageProps<"/automation">) {
  const { profile } = await requirePermission("automation:run");
  const params = await searchParams;
  // ?competence=2026-08 vem do Dashboard ("Agendar N pendentes"); a tela abre com os pendentes marcados
  const asked = typeof params.competence === "string" ? toCompetenceKey(params.competence) : null;
  const competence = asked && asked <= currentCompetence() ? asked : previousCompetence();

  const supabase = await createClient();
  const [clients, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase
      .from("automation_jobs")
      .select("client_id, competence, status, created_at, operations")
      .eq("competence", competence)
      .not("operations", "cs", "{EFD_CHECK}")
      .not("operations", "cs", "{MALHA_CHECK}")
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);
  // pedido só de canceladas não conta como "mês solicitado"; na empresa só de serviço vale a busca de NFS-e
  const jobs = (jobsRes.data ?? []) as { client_id: string; competence: string; status: JobStatus; created_at: string; operations: string[] }[];
  const nfseOnly = new Set(clients.filter((c) => !c.uses_siat).map((c) => c.id));

  return (
    <>
      <PageHeader title="Executar automações" />
      <AutomationScheduler
        key={competence}
        clients={clients}
        canForce={can(profile.role, "automation:force")}
        initialCompetence={competence}
        initialStatuses={plannerStatusMap(jobs, competence, nfseOnly)}
      />
    </>
  );
}
