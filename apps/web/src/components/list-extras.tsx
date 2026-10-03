"use client";

// Peças do refino de 03/10/2026 usadas em Automação, EFD, Malhas e Downloads: caixinha de seleção,
// abas de situação com cor, grupo de bloqueados no fim da lista e barra fixa no rodapé do card.

import { Check, ChevronDown, ChevronRight, CircleHelp, Lock, Minus } from "lucide-react";
import Link from "next/link";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Caixinha 16px: marcada, parcial (cabeçalho) ou vazia. */
export function CheckBox({ on, partial = false, className }: { on: boolean; partial?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "box-border grid size-4 shrink-0 place-items-center rounded border-[1.5px] text-white",
        on || partial ? "border-primary bg-primary" : "border-(--c-cfcfca) bg-card",
        className,
      )}
    >
      {on ? <Check className="size-[11px]" /> : partial ? <Minus className="size-[11px]" /> : null}
    </span>
  );
}

/** Caixinha do cabeçalho: seleciona os visíveis e selecionáveis. */
export function CheckAll({
  all,
  some,
  disabled,
  onToggle,
}: {
  all: boolean;
  some: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={all ? "Desmarcar todos" : "Selecionar todos"}
      onClick={onToggle}
      disabled={disabled}
      className="disabled:opacity-40"
    >
      <CheckBox on={all} partial={!all && some} />
    </button>
  );
}

export interface StatusTab<T extends string> {
  key: T;
  label: string;
  count: number;
  /** quadradinho 7x7 da cor da situação (sem cor: "Todos") */
  color?: string;
  icon?: React.ReactNode;
}

/** Abas de situação com cor (EFD, Malhas, Downloads). */
export function StatusTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: StatusTab<T>[];
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist">
      {tabs.map((t) => {
        const on = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-[5px] text-[12.5px] whitespace-nowrap transition-colors",
              on ? "bg-(--c-e6f4ec) font-medium text-(--c-17603b)" : "text-(--c-4a4b46) hover:bg-(--c-f2f3ef)",
            )}
          >
            {t.icon ?? (t.color ? <span className="size-[7px] shrink-0 rounded-[2px]" style={{ background: t.color }} /> : null)}
            {t.label}
            <span className={cn("font-mono text-xs", on ? "text-(--c-17603b)" : "text-(--c-6b6c66)")}>{t.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface LockedRow {
  id: string;
  name: string;
  code: string;
  reason: string;
  /** motivo em vermelho (ex.: sem certificado válido) */
  danger?: boolean;
  action?: { label: string; href: string };
}

/** Bloqueados agrupados no fim da lista: uma linha recolhível com o motivo de cada um. */
export function LockedGroup({
  title,
  rows,
  open,
  onToggle,
}: {
  title: string;
  rows: LockedRow[];
  open: boolean;
  onToggle: () => void;
}) {
  if (rows.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b border-(--c-f2f2ef) bg-(--c-fafaf8) px-3.5 py-2.5 text-left text-[12.5px] text-(--c-4a4b46) hover:bg-(--c-f5f5f1)"
      >
        <Chevron className="size-3.5 text-(--c-6b6c66)" />
        <Lock className="size-[13px] text-(--c-6b6c66)" />
        <span className="flex-1">{title}</span>
      </button>
      {open
        ? rows.map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[28px_minmax(0,2fr)_minmax(0,1.5fr)_auto] items-center gap-3 border-b border-(--c-f2f2ef) bg-(--c-fafaf8)/60 px-3.5 py-2.5"
            >
              <Lock className="size-3 justify-self-center text-(--c-a3a39e)" />
              <div className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-[13px] font-medium text-(--c-4a4b46)">{r.name}</span>
                <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{r.code}</span>
              </div>
              <span className={cn("text-xs", r.danger ? "text-(--c-b42323)" : "text-(--c-6b6c66)")}>{r.reason}</span>
              {r.action ? (
                <Link href={r.action.href} className="text-xs font-medium whitespace-nowrap text-primary">
                  {r.action.label} →
                </Link>
              ) : (
                <span />
              )}
            </div>
          ))
        : null}
    </>
  );
}

/**
 * Barra fixa no rodapé do card da lista (o card precisa de overflow-clip, não hidden, senão o
 * sticky não gruda). Verde depois de processar.
 */
export function StickyBar({ success = false, children }: { success?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-[2] flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-b-xl border-t border-(--c-e8e8e4) px-3.5 py-3 shadow-[0_-6px_16px_rgba(28,29,27,.05)]",
        success ? "bg-(--c-eef7f1)" : "bg-card",
      )}
    >
      {children}
    </div>
  );
}

/** "?" ao lado do título da página, com a explicação no mouse (substitui a descrição e o "Como funciona"). */
export function HelpTip({ children, label = "Como funciona" }: { children: React.ReactNode; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="grid size-[22px] place-items-center rounded-full text-(--c-6b6c66) hover:bg-(--c-f2f3ef) hover:text-foreground"
        >
          <CircleHelp className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[340px] space-y-1.5 text-xs leading-[1.45]">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/** Interruptor 30x18 (Forçar reagendamento). */
export function MiniSwitch({
  on,
  onChange,
  label,
  activeClass = "bg-(--c-d98e0b)",
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  activeClass?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn("relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors", on ? activeClass : "bg-(--c-d4d4cf)")}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left]",
          on ? "left-3.5" : "left-0.5",
        )}
      />
    </button>
  );
}
