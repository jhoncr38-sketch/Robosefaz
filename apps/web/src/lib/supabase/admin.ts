import "server-only";

import { createClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env";

/**
 * Cliente com service role — SOMENTE no servidor e somente para operações
 * administrativas de autenticação (criar/convidar usuários). Nunca exposto ao browser.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no servidor do painel.");
  }
  return createClient(publicEnv.supabaseUrl, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
