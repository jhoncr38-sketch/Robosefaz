"use client";

import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface FilterDef {
  name: string;
  placeholder: string;
  options: { value: string; label: string }[];
  width?: string;
}

const ALL = "__all__";

/** Filtros persistidos na URL (?chave=valor), para páginas renderizadas no servidor. */
export function ListFilters({ filters }: { filters: FilterDef[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function update(name: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) next.delete(name);
    else next.set(name, value);
    router.push(`${pathname}?${next.toString()}`);
  }

  const hasAny = filters.some((f) => params.get(f.name));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((f) => (
        <Select key={f.name} value={params.get(f.name) ?? ALL} onValueChange={(v) => update(f.name, v)}>
          <SelectTrigger className={f.width ?? "w-48"}>
            <SelectValue placeholder={f.placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{f.placeholder}</SelectItem>
            {f.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {hasAny ? (
        <Button variant="ghost" size="sm" onClick={() => router.push(pathname)}>
          <X /> Limpar
        </Button>
      ) : null}
    </div>
  );
}
