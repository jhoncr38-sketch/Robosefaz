import { Search } from "lucide-react";

/** Busca da tela Notas: número, chave de acesso, CNPJ/CPF ou nome (formulário simples, sem JS). */
export function NotesSearch({ q }: { q: string }) {
  return (
    <form method="get" action="/notes" className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
      <label className="flex h-9 min-w-[260px] flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 focus-within:border-ring">
        <Search className="size-4 shrink-0 text-(--c-6b6c66)" />
        <input
          name="q"
          defaultValue={q}
          autoFocus
          autoComplete="off"
          placeholder="Número da nota, chave de acesso, CNPJ/CPF ou nome"
          aria-label="Buscar nota"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ellipsis outline-none placeholder:text-(--c-6b6c66)"
        />
      </label>
      <button
        type="submit"
        className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-medium text-white hover:bg-(--c-196640)"
      >
        Buscar
      </button>
    </form>
  );
}
