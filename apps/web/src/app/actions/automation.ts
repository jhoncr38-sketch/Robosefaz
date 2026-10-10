"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, CreateJobResult, ExportTaskType } from "@/lib/types";
import { automationRequestSchema, competenceSchema, exportOperationSchema } from "@/lib/validation";

export interface BatchSummary {
  created: number;
  duplicates: number;
  failed: number;
  results: CreateJobResult[];
  /** buscas de NFS-e Nacional pedidas junto */
  nfse?: number;
  /** empresas só de serviço que entraram na fila (só NFS-e) */
  nfseQueued?: string[];
}

function rpcError(message: string): string {
  const m = /^(?:[A-Z_]+):\s*(.*)$/.exec(message);
  return m ? m[1] : message;
}

function revalidateQueue() {
  revalidatePath("/queue");
  revalidatePath("/dashboard");
  revalidatePath("/history");
}

export async function createJobs(input: z.input<typeof automationRequestSchema>): Promise<ActionResult<BatchSummary>> {
  const auth = await authorize("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = automationRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  if (parsed.data.force && !can(auth.session.profile.role, "automation:force")) {
    return { ok: false, error: "Seu perfil não pode forçar novo agendamento." };
  }

  const supabase = await createClient();
  let results: CreateJobResult[] = [];
  if (parsed.data.client_ids.length > 0) {
    const { data, error } = await supabase.rpc("create_automation_jobs_batch", {
      p_client_ids: parsed.data.client_ids,
      p_competence: parsed.data.competence,
      p_operations: parsed.data.operations,
      p_force: parsed.data.force,
      p_respect_client_flags: parsed.data.respect_client_flags,
    });
    if (error) return { ok: false, error: rpcError(error.message) };
    results = (data ?? []) as CreateJobResult[];
  }

  const summary: BatchSummary = {
    created: results.filter((r) => r.job_id).length,
    duplicates: results.filter((r) => r.duplicate).length,
    failed: results.filter((r) => !r.job_id && !r.duplicate).length,
    results,
  };
  // NFS-e junto com o pedido do mês: para quem entrou na fila agora e para as empresas só de serviço
  let nfseNote = "";
  const nfseOnly = parsed.data.nfse ? parsed.data.nfse_client_ids : [];
  const queued = [...new Set([...results.filter((r) => r.job_id).map((r) => r.client_id), ...nfseOnly])];
  if (parsed.data.nfse && queued.length > 0) {
    const nfse = await supabase.rpc("create_nfse_fetch_jobs", { p_client_ids: queued, p_competence: parsed.data.competence });
    if (nfse.error) nfseNote = ` A busca de NFS-e não foi pedida: ${rpcError(nfse.error.message)}`;
    else {
      const out = nfse.data as { created: number; results: { client_id: string; job_id?: string }[] };
      summary.nfse = out.created;
      summary.nfseQueued = out.results.filter((r) => r.job_id && nfseOnly.includes(r.client_id)).map((r) => r.client_id);
      if (summary.nfse) nfseNote = ` ${summary.nfse} busca(s) de NFS-e.`;
    }
  }
  revalidateQueue();
  return {
    ok: true,
    data: summary,
    message: `${summary.created} tarefa(s) criada(s)${summary.duplicates ? `, ${summary.duplicates} já agendada(s)` : ""}.${nfseNote}`,
  };
}

const singleSchema = z.object({
  clientId: z.uuid(),
  competence: competenceSchema,
  operations: z.array(exportOperationSchema).min(1, "Selecione ao menos uma operação"),
  force: z.boolean().default(false),
});

export async function createClientJob(input: {
  clientId: string;
  competence: string;
  operations: ExportTaskType[];
  force?: boolean;
}): Promise<ActionResult<CreateJobResult>> {
  const auth = await authorize("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = singleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  if (parsed.data.force && !can(auth.session.profile.role, "automation:force")) {
    return { ok: false, error: "Seu perfil não pode forçar novo agendamento." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_automation_job", {
    p_client_id: parsed.data.clientId,
    p_competence: parsed.data.competence,
    p_operations: parsed.data.operations,
    p_force: parsed.data.force,
  });
  if (error) return { ok: false, error: rpcError(error.message) };
  const result = data as CreateJobResult;
  revalidateQueue();
  revalidatePath(`/clients/${parsed.data.clientId}`);
  if (result.duplicate) return { ok: true, data: result, message: "Exportação já agendada." };
  const skipped = result.skipped?.length ? ` (${result.skipped.length} já agendada(s))` : "";
  return { ok: true, data: result, message: `Automação iniciada${skipped}.` };
}

async function jobRpc(fn: string, jobId: string, permission: "automation:cancel" | "automation:retry" | "automation:run", ok: string): Promise<ActionResult> {
  const auth = await authorize(permission);
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, { p_job_id: jobId });
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidateQueue();
  revalidatePath(`/history/${jobId}`);
  return { ok: true, message: ok };
}

export async function cancelJob(jobId: string): Promise<ActionResult> {
  return jobRpc("cancel_automation_job", jobId, "automation:cancel", "Cancelamento solicitado.");
}

export async function retryJob(jobId: string): Promise<ActionResult> {
  return jobRpc("retry_automation_job", jobId, "automation:retry", "Job devolvido à fila.");
}

export async function confirmManualAction(jobId: string): Promise<ActionResult> {
  return jobRpc("confirm_manual_action", jobId, "automation:run", "Automação liberada para continuar.");
}
