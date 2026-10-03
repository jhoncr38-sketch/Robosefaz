import type { Metadata } from "next";

import { QueueTable } from "@/components/queue/queue-table";
import { requireSession } from "@/lib/auth";
import { isoDaysFromNow } from "@/lib/format";
import { computersFrom } from "@/lib/pc-wait";
import { JOB_SELECT } from "@/lib/queries";
import { queueTabFromParam } from "@/lib/queue-view";
import { createClient } from "@/lib/supabase/server";
import type { AutomationJob } from "@/lib/types";

export const metadata: Metadata = { title: "Fila de processamento" };

export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  const { profile } = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const since = isoDaysFromNow(-7);
  const [{ data }, { data: heartbeats }, { data: downloads }] = await Promise.all([
    supabase
      .from("automation_jobs")
      .select(JOB_SELECT)
      .or(`created_at.gte.${since},status.not.in.(completed,failed,cancelled)`)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("worker_heartbeats").select("worker_id, hostname, status, last_seen_at").gte("last_seen_at", isoDaysFromNow(-30)),
    // arquivos baixados por trabalho (coluna "Arquivos" dos finalizados)
    supabase.from("downloads").select("job_id").gte("created_at", isoDaysFromNow(-8)).limit(5000),
  ]);
  const files: Record<string, number> = {};
  for (const d of downloads ?? []) if (d.job_id) files[d.job_id] = (files[d.job_id] ?? 0) + 1;
  const now = new Date();
  const computers = computersFrom(heartbeats ?? [], now.getTime());

  return (
    <QueueTable
      initialJobs={(data ?? []) as AutomationJob[]}
      role={profile.role}
      computers={computers}
      serverNow={now.toISOString()}
      initialTab={queueTabFromParam(params.aba)}
      files={files}
      filesSince={now.toISOString()}
    />
  );
}
