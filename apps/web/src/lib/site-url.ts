import "server-only";

import { headers } from "next/headers";

/**
 * Endereço do painel de onde veio o pedido (jrsistema.com, ou localhost nos testes) para os
 * links dos e-mails. Sem origem conhecida, o Supabase usa o Site URL (https://jrsistema.com).
 * O endereço precisa estar na lista "Redirect URLs" do Supabase.
 */
export async function siteUrl(path: string): Promise<string | undefined> {
  const origin = (await headers()).get("origin");
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) return undefined;
  return new URL(path, origin).toString();
}
