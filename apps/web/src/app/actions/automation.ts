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
    return { ok: false, error: "Somente administradores podem forçar novo agendamento." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_automation_jobs_batch", {
    p_client_ids: parsed.data.client_ids,
    p_competence: parsed.data.competence,
    p_operations: parsed.data.operations,
    p_force: parsed.data.force,
    p_respect_client_flags: parsed.data.respect_client_flags,
  });
  if (error) return { ok: false, error: rpcError(error.message) };

  const results = (data ?? []) as CreateJobResult[];
  const summary: BatchSummary = {
    created: results.filter((r) => r.job_id).length,
    duplicates: results.filter((r) => r.duplicate).length,
    failed: results.filter((r) => !r.job_id && !r.duplicate).length,
    results,
  };
  revalidateQueue();
  return {
    ok: true,
    data: summary,
    message: `${summary.created} tarefa(s) criada(s)${summary.duplicates ? `, ${summary.duplicates} já agendada(s)` : ""}.`,
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
    return { ok: false, error: "Somente administradores podem forçar novo agendamento." };
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
