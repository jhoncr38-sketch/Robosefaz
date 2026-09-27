"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { competenceSchema } from "@/lib/validation";

export interface EfdCheckSummary {
  created: number;
  skipped: number;
  results: { client_id: string; job_id?: string; skipped?: boolean; message?: string }[];
}

const efdCheckSchema = z.object({
  client_ids: z.array(z.uuid()).min(1, "Selecione ao menos um cliente"),
  competence: competenceSchema,
});

function rpcError(message: string): string {
  const m = /^(?:[A-Z_]+):\s*(.*)$/.exec(message);
  return m ? m[1] : message;
}

/** Botão "Consultar processamento de EFD": um pedido por cliente para o robô ler o DT-e. */
export async function requestEfdCheck(input: z.input<typeof efdCheckSchema>): Promise<ActionResult<EfdCheckSummary>> {
  const auth = await authorize("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = efdCheckSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_efd_check_jobs", {
    p_client_ids: parsed.data.client_ids,
    p_competence: parsed.data.competence,
  });
  if (error) return { ok: false, error: rpcError(error.message) };

  const summary = data as EfdCheckSummary;
  revalidatePath("/efd");
  revalidatePath("/queue");
  return {
    ok: true,
    data: summary,
    message: `${summary.created} consulta(s) na fila${summary.skipped ? `, ${summary.skipped} já estava(m) na fila` : ""}.`,
  };
}
