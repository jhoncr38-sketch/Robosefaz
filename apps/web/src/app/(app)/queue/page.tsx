import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { QueueTable } from "@/components/queue/queue-table";
import { requireSession } from "@/lib/auth";
import { isoDaysFromNow } from "@/lib/format";
import { JOB_SELECT } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob } from "@/lib/types";

export const metadata: Metadata = { title: "Fila de processamento" };

export default async function QueuePage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const since = isoDaysFromNow(-7);
  const { data } = await supabase
    .from("automation_jobs")
    .select(JOB_SELECT)
    .or(`created_at.gte.${since},status.not.in.(completed,failed,cancelled)`)
    .order("created_at", { ascending: false })
    .limit(500);

  return (
    <>
      <PageHeader
        title="Fila de processamento"
        description="Acompanhe em tempo real cada cliente sendo processado pelo robô."
      />
      <QueueTable initialJobs={(data ?? []) as AutomationJob[]} role={profile.role} />
    </>
  );
}
