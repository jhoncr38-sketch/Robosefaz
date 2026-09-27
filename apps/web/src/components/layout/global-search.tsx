"use client";

import { ArrowRight, Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatCNPJ } from "@/lib/cnpj";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface ClientHit {
  id: string;
  client_code: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  active: boolean;
}

const MAX_HITS = 6;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Todas as palavras precisam aparecer (nome, código ou CNPJ; com ou sem acento e pontuação). */
function matches(c: ClientHit, query: string): boolean {
  const hay = normalize(`${c.trade_name ?? ""} ${c.legal_name} ${c.client_code}`);
  const cnpj = c.cnpj.toLowerCase();
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => {
      if (hay.includes(word)) return true;
      const compact = word.replace(/[^0-9a-z]/g, "");
      return compact.length >= 3 && cnpj.includes(compact);
    });
}

/**
 * Busca com sugestões: ao digitar, lista os clientes encontrados; clicando, abre a página do cliente.
 * Não troca de tela enquanto você digita. Ctrl+K põe o cursor aqui.
 */
export function GlobalSearch() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [clients, setClients] = useState<ClientHit[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    }
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  /** Carrega a lista de clientes uma vez (na primeira vez que a busca é usada). */
  async function ensureLoaded() {
    if (clients || loading) return;
    setLoading(true);
    const { data } = await createClient()
      .from("clients")
      .select("id, client_code, legal_name, trade_name, cnpj, active")
      .order("legal_name")
      .limit(5000);
    setClients((data ?? []) as ClientHit[]);
    setLoading(false);
  }

  const term = q.trim();
  const hits = term && clients ? clients.filter((c) => matches(c, term)) : [];
  const shown = hits.slice(0, MAX_HITS);

  function openClient(c: ClientHit) {
    setOpen(false);
    setQ("");
    ref.current?.blur();
    router.push(`/clients/${c.id}`);
  }

  function seeAll() {
    setOpen(false);
    ref.current?.blur();
    router.push(`/clients?q=${encodeURIComponent(term)}`);
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-[380px]">
      <div className="flex h-[34px] w-full items-center gap-2 rounded-lg border border-input bg-(--c-fafaf8) px-2.5 text-[13px] focus-within:border-ring focus-within:bg-card">
        <Search className="size-3.5 shrink-0 text-(--c-9a9b94)" />
        <input
          ref={ref}
          value={q}
          role="combobox"
          aria-expanded={open && !!term}
          aria-controls="global-search-results"
          aria-label="Buscar cliente, código ou CNPJ"
          placeholder="Buscar cliente, código ou CNPJ"
          onFocus={() => {
            void ensureLoaded();
            setOpen(true);
          }}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
            void ensureLoaded();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              ref.current?.blur();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (shown[active]) openClient(shown[active]);
              else if (term) seeAll();
            }
          }}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--c-9a9b94)"
        />
        {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-(--c-9a9b94)" /> : null}
      </div>

      {open && term ? (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute top-[40px] left-0 z-40 w-full overflow-hidden rounded-[10px] border bg-popover shadow-[0_12px_30px_rgba(0,0,0,.12)]"
        >
          <p className="px-3 pt-2 pb-1 text-[11px] tracking-[0.04em] text-(--c-9a9b94) uppercase">Clientes</p>
          {clients === null ? (
            <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Carregando…</p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-muted-foreground">Nenhum cliente encontrado.</p>
          ) : (
            shown.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openClient(c)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
                  i === active && "bg-(--c-f3faf6)",
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {c.trade_name || c.legal_name}
                    {!c.active ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(inativo)</span> : null}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-(--c-7a7b75)">
                    {c.client_code} · {formatCNPJ(c.cnpj)}
                  </span>
                </span>
                <ArrowRight className={cn("size-3.5 shrink-0 text-primary", i === active ? "opacity-100" : "opacity-0")} />
              </button>
            ))
          )}
          {hits.length > 0 ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={seeAll}
              className="w-full border-t border-(--c-f2f2ef) px-3 py-2 text-left text-xs font-medium text-primary hover:bg-(--c-fafaf8)"
            >
              {hits.length > MAX_HITS ? `Ver todos os ${hits.length} em Clientes` : "Ver em Clientes"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
