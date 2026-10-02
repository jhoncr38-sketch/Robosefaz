import type { Metadata } from "next";

import { ListCard, ListToolbar, LoadMore } from "@/components/data-list";
import { JobsTable } from "@/components/jobs-table";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { formatCompetence, recentCompetences } from "@/lib/competence";
import { moreHref, parseShown } from "@/lib/paging";
import { JOB_SELECT, loadProfilesMap } from "@/lib/queries";
import { JOB_STATUS_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob, JobStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Histórico" };

/** execuções por lote do "Carregar mais" */
const PAGE = 300;

export default async function HistoryPage({ searchParams }: PageProps<"/history">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  const shown = parseShown(params.mostrar, PAGE);
  let query = supabase
    .from("automation_jobs")
    .select(JOB_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(shown);
  if (typeof params.competence === "string") query = query.eq("competence", params.competence);
  if (typeof params.client === "string") query = query.eq("client_id", params.client);
  if (typeof params.status === "string") query = query.eq("status", params.status);

  const [{ data, count }, users, { data: clients }] = await Promise.all([
    query,
    loadProfilesMap(),
    supabase.from("clients").select("id, legal_name, trade_name").order("legal_name"),
  ]);

  return (
    <>
      <PageHeader title="Histórico" description="Todas as execuções do robô, com usuário, resultado e duração." />
      <ListCard>
        <ListToolbar>
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
        </ListToolbar>
        <JobsTable jobs={(data ?? []) as AutomationJob[]} users={users} />
        <LoadMore
          shown={(data ?? []).length}
          total={count ?? 0}
          step={PAGE}
          href={moreHref("/history", params, shown, PAGE)}
          noun={["execução", "execuções", "f"]}
        />
      </ListCard>
    </>
  );
}
