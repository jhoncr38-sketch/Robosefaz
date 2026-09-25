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

const NUMERIC_SETTINGS = new Set(["collector_interval_minutes", "collector_max_checks", "certificate_warning_days"]);

export async function updateSetting(key: string, rawValue: string): Promise<ActionResult> {
  const auth = await authorize("settings:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  let value: unknown = rawValue;
  if (NUMERIC_SETTINGS.has(key)) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) return { ok: false, error: "Informe um número inteiro válido." };
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
