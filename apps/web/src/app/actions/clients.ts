"use server";

import { revalidatePath } from "next/cache";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, Client } from "@/lib/types";
import { clientSchema, type ClientInput } from "@/lib/validation";

function dbError(message: string, code?: string): string {
  if (code === "23505" || /clients_cnpj_key/.test(message)) return "Já existe um cliente com este CNPJ.";
  if (/row-level security/.test(message)) return "Você não tem permissão para esta ação.";
  if (/clients_cnpj_valid/.test(message)) return "CNPJ inválido.";
  return message;
}

export async function saveClient(id: string | null, input: ClientInput): Promise<ActionResult<Client>> {
  const auth = await authorize("clients:write");
  if ("error" in auth) return { ok: false, error: auth.error };

  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Verifique os campos do formulário.", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const payload = parsed.data;
  const query = id
    ? supabase.from("clients").update(payload).eq("id", id).select("*").single()
    : supabase
        .from("clients")
        .insert({ ...payload, created_by: auth.session.userId })
        .select("*")
        .single();
  const { data, error } = await query;
  if (error) return { ok: false, error: dbError(error.message, error.code) };

  revalidatePath("/clients");
  revalidatePath(`/clients/${data.id}`);
  revalidatePath("/dashboard");
  return { ok: true, data: data as Client, message: id ? "Cliente atualizado." : "Cliente criado." };
}

export async function setClientActive(id: string, active: boolean): Promise<ActionResult> {
  const auth = await authorize("clients:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase.from("clients").update({ active }).eq("id", id);
  if (error) return { ok: false, error: dbError(error.message, error.code) };
  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true, message: active ? "Cliente ativado." : "Cliente desativado." };
}
