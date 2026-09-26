"use server";

import { revalidatePath } from "next/cache";

import { authorize } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/** Gera o código de ativação (8 caracteres, 30 minutos, uso único). */
export async function createActivationCode(): Promise<ActionResult<{ code: string; expires_at: string }>> {
  const auth = await authorize("users:manage");
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_device_activation_code");
  if (error) return { ok: false, error: /FORBIDDEN/.test(error.message) ? "Somente administradores." : error.message };
  return { ok: true, data: data as { code: string; expires_at: string } };
}

/** Desativa o computador: o robô dele perde o acesso na hora. */
export async function revokeDevice(deviceId: string): Promise<ActionResult> {
  const auth = await authorize("users:manage");
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_device", { p_device_id: deviceId });
  if (error) return { ok: false, error: /NOT_FOUND/.test(error.message) ? "Computador não encontrado." : error.message };

  // apaga também o login técnico (o banco já bloqueia; isto encerra as sessões)
  const authUserId = (data as { auth_user_id: string | null } | null)?.auth_user_id;
  if (authUserId) {
    try {
      await createAdminClient().auth.admin.deleteUser(authUserId);
    } catch {
      // sem service role no painel: o bloqueio pelo banco já é suficiente
    }
  }
  revalidatePath("/devices");
  return { ok: true, message: "Computador desativado. O robô dele parou de ter acesso." };
}
