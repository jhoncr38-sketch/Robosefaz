"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { AutomationJob, JobStatus } from "@/lib/types";

// Etapas depois do agendamento: o robô já terminou a parte dele e a SEFAZ processa.
export const SEFAZ_PHASE: JobStatus[] = [
  "waiting_sefaz",
  "checking_processing",
  "download_available",
  "downloading",
  "organizing_files",
];
const EXPORT_TASKS = ["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"];

/**
 * Quando cada job entrou na espera da SEFAZ: o último agendamento feito no SIAT
 * (automation_tasks.requested_at). Separa "tempo do robô" de "tempo da SEFAZ".
 */
export function useWaitingSince(jobs: AutomationJob[]): Record<string, string> {
  const key = jobs
    .filter((j) => SEFAZ_PHASE.includes(j.status))
    .map((j) => j.id)
    .sort()
    .join(",");
  const [since, setSince] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    createClient()
      .from("automation_tasks")
      .select("job_id, requested_at")
      .in("job_id", key.split(","))
      .in("task_type", EXPORT_TASKS)
      .not("requested_at", "is", null)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const out: Record<string, string> = {};
        for (const row of data as { job_id: string; requested_at: string }[]) {
          if (!out[row.job_id] || row.requested_at > out[row.job_id]) out[row.job_id] = row.requested_at;
        }
        setSince(out);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return since;
}
