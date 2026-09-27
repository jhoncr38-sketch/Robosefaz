"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Busca de clientes por nome, código ou CNPJ (Ctrl+K). Abre a lista de clientes já filtrada. */
export function GlobalSearch() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      role="search"
      className="flex h-[34px] w-full max-w-[380px] items-center gap-2 rounded-lg border border-input bg-(--c-fafaf8) px-2.5 text-[13px] focus-within:border-ring focus-within:bg-card"
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        router.push(term ? `/clients?q=${encodeURIComponent(term)}` : "/clients");
        ref.current?.blur();
      }}
    >
      <Search className="size-3.5 shrink-0 text-(--c-9a9b94)" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar cliente, código ou CNPJ"
        aria-label="Buscar cliente, código ou CNPJ"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--c-9a9b94)"
      />
      <kbd className="hidden shrink-0 rounded border border-input bg-card px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-(--c-9a9b94) md:block">
        Ctrl K
      </kbd>
    </form>
  );
}
