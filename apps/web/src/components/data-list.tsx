// Listas no padrão do redesenho: card com borda, cabeçalho em maiúsculas e linhas em
// grid (sem rolagem lateral). Cada tela define as colunas com classes grid-cols-[...].
import { Search } from "lucide-react";
import Link from "next/link";

import type { ExportTaskType } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ListCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn("overflow-hidden rounded-xl border bg-card", className)}>{children}</section>;
}

/** Título do card (ex.: "Jobs com erro") com contador e ações opcionais. */
export function ListTitle({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[#efefeb] px-4 py-3.5">
      <p className="flex-1 text-[14.5px] font-semibold">
        {title}
        {count !== undefined ? <span className="ml-2 font-mono text-xs font-normal text-[#9a9b94]">{count}</span> : null}
      </p>
      {children}
    </div>
  );
}

export function ListToolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2.5 border-b border-[#efefeb] px-3.5 py-3">{children}</div>;
}

export function ListHead({ grid, children }: { grid: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        grid,
        "items-center border-b border-[#efefeb] bg-[#fafaf8] px-4 py-[9px] text-[11.5px] tracking-[0.04em] text-[#7a7b75] uppercase",
      )}
    >
      {children}
    </div>
  );
}

const ROW = "items-center border-b border-[#f2f2ef] px-4 py-2.5 text-[13px] text-foreground last:border-b-0";

/** Linha da lista; com `href`, a linha inteira é um link. */
export function ListRow({
  grid,
  href,
  className,
  children,
}: {
  grid: string;
  href?: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (href) {
    return (
      <Link href={href} className={cn(grid, ROW, "hover:bg-[#fafaf8] hover:no-underline", className)}>
        {children}
      </Link>
    );
  }
  return <div className={cn(grid, ROW, className)}>{children}</div>;
}

/** Nome em destaque e linha secundária (código, competência...). */
export function PrimaryCell({ title, sub, className }: { title: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-px", className)}>
      <span className="truncate text-[13px] font-medium">{title}</span>
      {sub ? <span className="truncate text-[11.5px] text-[#7a7b75]">{sub}</span> : null}
    </div>
  );
}

export function Muted({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("text-xs text-[#7a7b75]", className)}>{children}</span>;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: [T, string, number?][];
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-[7px] bg-[#f3f3f0] p-0.5" role="tablist">
      {options.map(([key, label, count]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={cn(
            "rounded-[5px] px-2.5 py-[5px] text-xs whitespace-nowrap",
            value === key ? "bg-white text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
          )}
        >
          {label}
          {count !== undefined ? <span className="ml-1 font-mono text-[#9a9b94]">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

const OP_TAG: Record<ExportTaskType | "EFD_CHECK", string> = {
  NFCE_EXPORT: "NFC-e",
  NFE_ISSUED_EXPORT: "Emit.",
  NFE_RECEIVED_EXPORT: "Receb.",
  EFD_CHECK: "EFD",
};

export function OpTags({ ops }: { ops: (ExportTaskType | "EFD_CHECK")[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {ops.map((o) => (
        <span key={o} className="rounded bg-[#f2f2ef] px-[5px] py-0.5 font-mono text-[10.5px] whitespace-nowrap text-[#4a4b46]">
          {OP_TAG[o] ?? o}
        </span>
      ))}
    </span>
  );
}

export function ListEmptyText({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-[13px] text-muted-foreground">{children}</p>;
}

/** Campo de busca da barra da lista (usado em componentes de cliente). */
export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
      <Search className="size-3.5 text-[#9a9b94]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9a9b94]"
      />
    </div>
  );
}
