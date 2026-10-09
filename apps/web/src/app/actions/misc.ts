"use server";

import { revalidatePath } from "next/cache";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null)
    .eq("user_id", auth.session.userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const NUMERIC_SETTINGS = new Set([
  "collector_interval_minutes",
  "collector_max_checks",
  "certificate_warning_days",
  "quick_check_seconds",
  "quick_check_interval_seconds",
]);
/** limites por parâmetro (padrão: 1 a 10.000); a conferência rápida aceita 0 = desligada */
const NUMERIC_LIMITS: Record<string, [number, number]> = {
  quick_check_seconds: [0, 900],
  quick_check_interval_seconds: [10, 300],
};

export async function updateSetting(key: string, rawValue: string): Promise<ActionResult> {
  const auth = await authorize("settings:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  // parâmetros dos robôs valem para todos os escritórios: só o dono da plataforma altera
  if (!auth.session.profile.is_platform_owner) {
    return { ok: false, error: "Somente o dono da plataforma altera estes parâmetros." };
  }
  let value: unknown = rawValue;
  if (NUMERIC_SETTINGS.has(key)) {
    const n = Number(rawValue);
    const [min, max] = NUMERIC_LIMITS[key] ?? [1, 10_000];
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, error: `Informe um número inteiro entre ${min} e ${max}.` };
    }
    value = n;
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("app_settings")
    .update({ value, updated_by: auth.session.userId, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true, message: "Configuração salva." };
}
