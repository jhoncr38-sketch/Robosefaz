"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { authLinkTarget, parseAuthHash } from "@/lib/auth-link";
import { createClient } from "@/lib/supabase/client";

const noSubscribe = () => () => {};
const hasAuthHash = () => parseAuthHash(window.location.hash) !== null;

/**
 * Quem clica no convite (ou no "redefinir senha") volta ao painel com a sessão no fim do
 * endereço. O cliente do Supabase usado aqui só entende o fluxo com código, então a sessão é
 * gravada à mão e a pessoa segue para criar a senha, em vez de cair no login.
 */
export function AuthLinkHandler() {
  const pending = useSyncExternalStore(noSubscribe, hasAuthHash, () => false);
  const started = useRef(false);

  useEffect(() => {
    const link = parseAuthHash(window.location.hash);
    if (!link || started.current) return;
    started.current = true;
    // recarrega a página (sem a chave no endereço) para o servidor já enxergar a sessão nova
    if (link.kind === "error") {
      window.location.replace("/login?error=link");
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next") ?? "/dashboard";
    createClient()
      .auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken })
      .then(({ error }) => window.location.replace(error ? "/login?error=link" : authLinkTarget(link.type, next)));
  }, []);

  if (!pending) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-background">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Preparando seu acesso…
      </p>
    </div>
  );
}
