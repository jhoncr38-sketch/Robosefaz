import type { Metadata } from "next";

import { DownloadsTable } from "@/components/downloads-table";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { formatCompetence, recentCompetences } from "@/lib/competence";
import { DOCUMENT_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { DocumentType, DownloadRow } from "@/lib/types";

export const metadata: Metadata = { title: "Downloads" };

export default async function DownloadsPage({ searchParams }: PageProps<"/downloads">) {
  await requireSession();
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("downloads")
    .select("*, clients(client_code, legal_name, trade_name, cnpj)")
    .order("downloaded_at", { ascending: false })
    .limit(500);
  if (typeof params.competence === "string") query = query.eq("competence", params.competence);
  if (typeof params.client === "string") query = query.eq("client_id", params.client);
  if (typeof params.type === "string") query = query.eq("document_type", params.type);

  const [{ data }, { data: clients }] = await Promise.all([
    query,
    supabase.from("clients").select("id, legal_name, trade_name").order("legal_name"),
  ]);
  const rows = (data ?? []) as DownloadRow[];

  return (
    <>
      <PageHeader
        title="Downloads"
        description="Arquivos organizados em storage/downloads/{cliente}/{ano}/{mês}/{tipo}/ na máquina do worker."
      />
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
              name: "type",
              placeholder: "Todos os tipos",
              options: (Object.keys(DOCUMENT_LABEL) as DocumentType[]).map((d) => ({ value: d, label: DOCUMENT_LABEL[d] })),
            },
          ]}
        />
      </div>
      <Card className="py-0">
        <CardContent className="p-0">
          <DownloadsTable rows={rows} />
        </CardContent>
      </Card>
    </>
  );
}
