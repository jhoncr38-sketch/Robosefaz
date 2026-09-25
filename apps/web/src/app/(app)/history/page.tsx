import type { Metadata } from "next";

import { JobsTable } from "@/components/jobs-table";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { formatCompetence, recentCompetences } from "@/lib/competence";
import { JOB_SELECT, loadProfilesMap } from "@/lib/queries";
import { JOB_STATUS_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, JobStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Histórico" };

export default async function HistoryPage({ searchParams }: PageProps<"/history">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase.from("automation_jobs").select(JOB_SELECT).order("created_at", { ascending: false }).limit(300);
  if (typeof params.competence === "string") query = query.eq("competence", params.competence);
  if (typeof params.client === "string") query = query.eq("client_id", params.client);
  if (typeof params.status === "string") query = query.eq("status", params.status);

  const [{ data }, users, { data: clients }] = await Promise.all([
    query,
    loadProfilesMap(),
    supabase.from("clients").select("id, legal_name, trade_name").order("legal_name"),
  ]);

  return (
    <>
      <PageHeader title="Histórico" description="Todas as execuções do robô, com usuário, resultado e duração." />
      <div className="mb-4">
        <ListFilters
          filters={[
            {
              name: "competence",
              placeholder: "Todas as competências",
              options: recentCompetences(24).map((c) => ({ value: c, label: formatCompetence(c) })),
            },
            {
              name: "client",
              placeholder: "Todos os clientes",
              width: "w-64",
              options: (clients ?? []).map((c) => ({ value: c.id, label: c.trade_name || c.legal_name })),
            },
            {
              name: "status",
              placeholder: "Todos os status",
              options: (Object.keys(JOB_STATUS_LABEL) as JobStatus[]).map((s) => ({ value: s, label: JOB_STATUS_LABEL[s] })),
            },
          ]}
        />
      </div>
      <Card className="py-0">
        <CardContent className="p-0">
          <JobsTable jobs={(data ?? []) as AutomationJob[]} users={users} />
        </CardContent>
      </Card>
    </>
  );
}
