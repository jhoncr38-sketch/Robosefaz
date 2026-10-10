"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { currentCompetence } from "@/lib/competence";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";
import { competenceSchema } from "@/lib/validation";

export interface NfseFetchSummary {
  created: number;
  skipped: number;
  results: { client_id: string; job_id?: string; skipped?: boolean; message?: string }[];
}

const nfseFetchSchema = z.object({
  client_ids: z.array(z.uuid()).min(1, "Selecione ao menos um cliente").max(500),
  competence: competenceSchema.optional(),
});

function rpcError(message: string): string {
  const m = /^(?:[A-Z_]+):\s*(.*)$/.exec(message);
  return m ? m[1] : message;
}

/** "Buscar NFS-e": um pedido por cliente; o robô traz da NFS-e Nacional tudo o que é novo (qualquer mês). */
export async function requestNfseFetch(input: z.input<typeof nfseFetchSchema>): Promise<ActionResult<NfseFetchSummary>> {
  const auth = await authorize("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = nfseFetchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_nfse_fetch_jobs", {
    p_client_ids: parsed.data.client_ids,
    // a busca não é de um mês só; a competência só identifica o pedido nas telas
    p_competence: parsed.data.competence ?? currentCompetence(),
  });
  if (error) return { ok: false, error: rpcError(error.message) };

  const summary = data as NfseFetchSummary;
  revalidatePath("/nfse");
  revalidatePath("/queue");
  return {
    ok: true,
    data: summary,
    message: `${summary.created} busca(s) de NFS-e na fila${summary.skipped ? `, ${summary.skipped} já estava(m) na fila` : ""}.`,
  };
}
