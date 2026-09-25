import "server-only";

import type { PlannerClient } from "@/components/automation/planner-types";
import { certificateStatusFromDate } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { Certificate, Client } from "@/lib/types";

export const JOB_SELECT = "*, clients(client_code, legal_name, trade_name, cnpj)";

type ClientWithCerts = Client & { certificates: Pick<Certificate, "valid_until" | "active" | "status">[] | null };

export function activeCertificate<T extends { active: boolean }>(certs: T[] | null | undefined): T | null {
  return (certs ?? []).find((c) => c.active) ?? null;
}

export async function loadClientsWithCertificates(): Promise<ClientWithCerts[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*, certificates(valid_until, active, status)")
    .order("legal_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as ClientWithCerts[];
}

export async function loadPlannerClients(): Promise<PlannerClient[]> {
  const rows = await loadClientsWithCertificates();
  return rows.map((c) => {
    const cert = activeCertificate(c.certificates);
    return {
      id: c.id,
      client_code: c.client_code,
      legal_name: c.legal_name,
      trade_name: c.trade_name,
      cnpj: c.cnpj,
      active: c.active,
      uses_nfce: c.uses_nfce,
      uses_nfe_issued: c.uses_nfe_issued,
      uses_nfe_received: c.uses_nfe_received,
      certificate_status: cert ? certificateStatusFromDate(cert.valid_until) : null,
      certificate_valid_until: cert?.valid_until ?? null,
    };
  });
}

/** Última automação por cliente (para a lista de clientes). */
export async function loadLastJobByClient(): Promise<Record<string, { status: string; created_at: string; competence: string }>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("automation_jobs")
    .select("client_id, status, created_at, competence")
    .order("created_at", { ascending: false })
    .limit(1000);
  const map: Record<string, { status: string; created_at: string; competence: string }> = {};
  for (const row of data ?? []) {
    if (!map[row.client_id]) map[row.client_id] = row;
  }
  return map;
}

export async function loadProfilesMap(): Promise<Record<string, string>> {
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("user_id, name, email");
  return Object.fromEntries((data ?? []).map((p) => [p.user_id, p.name || p.email]));
}
