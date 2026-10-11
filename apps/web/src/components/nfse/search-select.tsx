"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type CodeOption, filterOptions } from "@/lib/nfse-tabelas";
import { cn } from "@/lib/utils";

/** Lista com busca, como a do site da prefeitura: digita parte do código ou do nome e escolhe. */
export function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  emptyLabel,
  disabled,
  label,
}: {
  value: string;
  options: CodeOption[];
  onChange: (value: string) => void;
  placeholder: string;
  /** quando presente, a lista ganha uma primeira linha que limpa o campo */
  emptyLabel?: string;
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;
  const rows = useMemo(() => {
    const found = filterOptions(options, query);
    return emptyLabel && !query.trim() ? [{ value: "", label: emptyLabel }, ...found] : found;
  }, [options, query, emptyLabel]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, cursor]);

  function toggle(next: boolean) {
    setOpen(next);
    if (!next) return;
    setQuery("");
    const at = (emptyLabel ? 1 : 0) + options.findIndex((o) => o.value === value);
    setCursor(value && at >= (emptyLabel ? 1 : 0) ? at : 0);
  }

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[cursor]) choose(rows[cursor].value);
    }
  }

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          title={selected?.label}
          className="flex h-8 w-full items-center gap-2 rounded-[7px] border border-input bg-card px-2.5 text-left text-[13px] outline-none transition-colors focus:border-ring disabled:cursor-not-allowed disabled:bg-(--c-f5f5f2) disabled:text-(--c-6b6c66)"
        >
          <span className={cn("min-w-0 flex-1 truncate", !selected && "text-(--c-6b6c66)")}>{selected?.label ?? placeholder}</span>
          <ChevronDown className="size-3.5 shrink-0 text-(--c-6b6c66)" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="w-(--radix-popover-trigger-width) max-w-[94vw] min-w-[300px] gap-1.5 p-1.5">
        <div className="flex items-center gap-2 rounded-[7px] border border-input bg-card px-2.5 focus-within:border-ring">
          <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
          <input
            className="h-8 w-full bg-transparent text-[13px] outline-none"
            placeholder="Buscar pelo código ou pelo nome"
            aria-label={`Buscar em ${label}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {/* a lista encolhe para caber no espaço que sobra na janela (a busca nunca fica fora da tela) */}
        <div ref={list} role="listbox" aria-label={label} className="thin-scrollbar max-h-[min(260px,calc(var(--radix-popover-content-available-height)-56px))] overflow-y-auto">
          {rows.length ? (
            rows.map((o, i) => (
              <div key={o.value || "__empty"}>
                {o.group && o.group !== rows[i - 1]?.group ? (
                  <p className="px-2 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-(--c-6b6c66) uppercase">{o.group}</p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  data-row={i}
                  onClick={() => choose(o.value)}
                  onMouseMove={() => setCursor(i)}
                  className={cn("flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12.5px] leading-snug", i === cursor && "bg-(--c-f5f5f1)")}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("block", !o.value && "text-(--c-6b6c66)")}>{o.label}</span>
                    {o.hint ? <span className="block text-[11.5px] text-(--c-6b6c66)">{o.hint}</span> : null}
                  </span>
                  {o.value && o.value === value ? <Check className="mt-0.5 size-3.5 shrink-0 text-primary" strokeWidth={3} /> : null}
                </button>
              </div>
            ))
          ) : (
            <p className="px-2 py-3 text-[12.5px] text-(--c-6b6c66)">Nada encontrado com esse texto.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
