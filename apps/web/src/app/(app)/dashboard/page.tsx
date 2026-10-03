import type { Metadata } from "next";

import { DashboardBoard, type DashboardCertSummary } from "@/components/dashboard/dashboard-board";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requireSession } from "@/lib/auth";
import { previousCompetence, toCompetenceKey } from "@/lib/competence";
import { isoDaysFromNow } from "@/lib/format";
import { can } from "@/lib/permissions";
import { JOB_SELECT } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { greeting, longDayLabel } from "@/lib/timezone";
import type { AutomationJob, DashboardStats } from "@/lib/types";

export const metadata: Metadata = { title: "Dashboard" };

const FINAL = "(completed,failed,cancelled)";

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const { profile } = await requireSession();
  const params = await searchParams;
  const supabase = await createClient();
  const competence =
    (typeof params.competence === "string" ? toCompetenceKey(params.competence) : null) ?? previousCompetence();
  const canRun = can(profile.role, "automation:run");

  const [statsRes, compJobsRes, recentRes, activeRes, clientsRes, nextCertRes, workersRes] = await Promise.all([
    supabase.rpc("dashboard_stats"),
    supabase.from("automation_jobs").select(JOB_SELECT).eq("competence", competence).order("created_at", { ascending: false }).limit(2000),
    supabase.from("automation_jobs").select(JOB_SELECT).order("created_at", { ascending: false }).limit(15),
    supabase.from("automation_jobs").select(JOB_SELECT).not("status", "in", FINAL).order("created_at").limit(300),
    supabase.from("clients").select("id, legal_name, trade_name").eq("active", true).order("legal_name"),
    supabase
      .from("certificates")
      .select("client_id, valid_until, clients(legal_name, trade_name)")
      .eq("active", true)
      .gt("valid_until", isoDaysFromNow(0))
      .order("valid_until")
      .limit(1),
    supabase.from("worker_heartbeats").select("worker_id, hostname"),
  ]);

  const stats = (statsRes.data ?? {}) as Partial<DashboardStats>;
  const n = (v?: number) => v ?? 0;

  // um job pode vir em mais de uma consulta
  const byId = new Map<string, AutomationJob>();
  for (const res of [compJobsRes, recentRes, activeRes]) {
    for (const job of (res.data ?? []) as AutomationJob[]) byId.set(job.id, job);
  }

  const nextCert = (nextCertRes.data ?? [])[0] as unknown as
    | { client_id: string; valid_until: string; clients: { legal_name: string; trade_name: string | null } | null }
    | undefined;
  const certs: DashboardCertSummary = {
    valid: n(stats.certificates_valid),
    expiring: n(stats.certificates_expiring),
    expired: n(stats.certificates_expired),
    next: nextCert
      ? {
          clientId: nextCert.client_id,
          name: nextCert.clients?.trade_name || nextCert.clients?.legal_name || "Cliente",
          validUntil: nextCert.valid_until,
        }
      : null,
  };

  const today = new Date();
  const firstName = (profile.name ?? "").trim().split(/\s+/)[0];

  return (
    <>
      <div className="mb-5">
        <p className="text-[13px] text-(--c-6b6c66)">{longDayLabel(today)}</p>
        <h1 className="mt-0.5 text-[22px] font-semibold tracking-[-0.01em] text-foreground">
          {greeting(today)}
          {firstName ? `, ${firstName}` : ""}
        </h1>
      </div>

      {params.error === "forbidden" ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>Você não tem permissão para acessar aquela página.</AlertDescription>
        </Alert>
      ) : null}

      <DashboardBoard
        competence={competence}
        initialJobs={[...byId.values()]}
        clients={(clientsRes.data ?? []).map((c) => ({ id: c.id, name: c.trade_name || c.legal_name }))}
        downloads={n(stats.downloads_available)}
        certs={certs}
        hostnames={Object.fromEntries((workersRes.data ?? []).filter((w) => w.hostname).map((w) => [w.worker_id, w.hostname]))}
        canRun={canRun}
      />
    </>
  );
}
