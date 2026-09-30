"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

export interface MalhaCheckSummary {
  created: number;
  skipped: number;
  results: { client_id: string; job_id?: string; skipped?: boolean; message?: string }[];
}

const malhaCheckSchema = z.object({
  client_ids: z.array(z.uuid()).min(1, "Selecione ao menos um cliente"),
});

function rpcError(message: string): string {
  const m = /^(?:[A-Z_]+):\s*(.*)$/.exec(message);
  return m ? m[1] : message;
}

/** Botão "Consultar malhas no SIAT": um pedido por cliente para o robô ler a Consulta de Malhas. */
export async function requestMalhaCheck(input: z.input<typeof malhaCheckSchema>): Promise<ActionResult<MalhaCheckSummary>> {
  const auth = await authorize("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = malhaCheckSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_malha_check_jobs", { p_client_ids: parsed.data.client_ids });
  if (error) return { ok: false, error: rpcError(error.message) };

  const summary = data as MalhaCheckSummary;
  revalidatePath("/malhas");
  revalidatePath("/queue");
  return {
    ok: true,
    data: summary,
    message: `${summary.created} consulta(s) na fila${summary.skipped ? `, ${summary.skipped} já estava(m) na fila` : ""}.`,
  };
}
