"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/env";

let browserClient: SupabaseClient | undefined;

export function createClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
  }
  return browserClient;
}

/**
 * Assina um canal de tempo real já com o login do usuário. O canal manda o token no momento em que
 * entra; na primeira abertura da página o token ainda não foi lido da sessão, e o Supabase registra a
 * assinatura como anônima (e não troca depois). Anônimo, o RLS esconde as mudanças: o aviso chega
 * vazio ("Error 401: Unauthorized") e a tela não se atualiza. Por isso espera o token antes de entrar.
 * Devolve a função que fecha o canal.
 */
export function subscribeWithAuth(channel: RealtimeChannel, callback?: (status: string) => void): () => void {
  const supabase = createClient();
  let closed = false;
  void supabase.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (!closed) channel.subscribe((status) => callback?.(status));
    });
  return () => {
    closed = true;
    void supabase.removeChannel(channel);
  };
}
