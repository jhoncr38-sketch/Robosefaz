import type { Metadata } from "next";

import { AutomationScheduler } from "@/components/automation/automation-scheduler";
import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth";
import { currentCompetence, previousCompetence, toCompetenceKey } from "@/lib/competence";
import { statusMapFromJobs } from "@/lib/competence-status";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { JobStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Automação SIAT" };

export default async function AutomationPage({ searchParams }: PageProps<"/automation">) {
  const { profile } = await requirePermission("automation:run");
  const params = await searchParams;
  // ?competence=2026-08&select=pending vem do Dashboard ("Agendar pendentes")
  const asked = typeof params.competence === "string" ? toCompetenceKey(params.competence) : null;
  const competence = asked && asked <= currentCompetence() ? asked : previousCompetence();

  const supabase = await createClient();
  const [clients, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase
      .from("automation_jobs")
      .select("client_id, competence, status, created_at")
      .eq("competence", competence)
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);
  const jobs = (jobsRes.data ?? []) as { client_id: string; competence: string; status: JobStatus; created_at: string }[];

  return (
    <>
      <PageHeader
        title="Automação SIAT"
        description="Agende a exportação de NFC-e e NF-e (emitidas e recebidas) de uma competência para vários clientes."
      />
      <AutomationScheduler
        key={`${competence}:${params.select ?? ""}`}
        clients={clients}
        canForce={can(profile.role, "automation:force")}
        initialCompetence={competence}
        initialStatuses={statusMapFromJobs(jobs, competence)}
        preselectPending={params.select === "pending"}
      />
    </>
  );
}
