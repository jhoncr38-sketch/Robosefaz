"use client";

import { Building2, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/page-header";
import { JobStatusBadge } from "@/components/status-badge";
import { formatCNPJ, normalizeCNPJ } from "@/lib/cnpj";
import { formatCompetence } from "@/lib/competence";
import { formatDate, formatRelative } from "@/lib/format";
import type { CertificateStatus, JobStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ClientRow {
  id: string;
  client_code: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  state_registration: string | null;
  active: boolean;
  certificate_status: CertificateStatus | null;
  certificate_valid_until: string | null;
  last_job: { status: string; created_at: string; competence: string } | null;
}

type Filter = "all" | "active" | "inactive";

// sem rolagem lateral: colunas agrupadas e, no celular, só cliente e última automação
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,2fr)_170px_150px_minmax(0,1.3fr)]";

const CERT_LABEL: Record<CertificateStatus, string> = {
  valid: "Válido",
  expiring: "Vencendo",
  expired: "Vencido",
  error: "Com erro",
};

function CertificateCell({ status, validUntil }: { status: CertificateStatus | null; validUntil: string | null }) {
  const ok = status === "valid" || status === "expiring";
  return (
    <div className="flex flex-col gap-px">
      {status ? (
        <span
          className={cn(
            "flex items-center gap-[5px] text-xs",
            status === "valid" ? "text-(--c-1c7a47)" : status === "expiring" ? "text-(--c-b45309)" : "text-(--c-b42323)",
          )}
        >
          {ok ? (
            <ShieldCheck className={cn("size-[13px]", status === "expiring" && "text-(--c-d97706)")} />
          ) : (
            <ShieldAlert className="size-[13px]" />
          )}
          {CERT_LABEL[status]}
        </span>
      ) : (
        <span className="flex items-center gap-[5px] text-xs text-(--c-b42323)">
          <ShieldAlert className="size-[13px]" /> Não configurado
        </span>
      )}
      {validUntil ? <span className="text-[11px] text-(--c-6b6c66)">até {formatDate(validUntil)}</span> : null}
    </div>
  );
}

export function ClientsTable({ rows, initialQuery = "" }: { rows: ClientRow[]; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = normalizeCNPJ(term).toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && !r.active) return false;
      if (filter === "inactive" && r.active) return false;
      if (!term) return true;
      return (
        r.legal_name.toLowerCase().includes(term) ||
        (r.trade_name ?? "").toLowerCase().includes(term) ||
        r.client_code.toLowerCase().includes(term) ||
        (digits.length >= 3 && r.cnpj.toLowerCase().includes(digits))
      );
    });
  }, [q, rows, filter]);

  const activeCount = rows.filter((r) => r.active).length;
  const filters: [Filter, string, number][] = [
    ["all", "Todos", rows.length],
    ["active", "Ativos", activeCount],
    ["inactive", "Inativos", rows.length - activeCount],
  ];

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
        <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
          <Search className="size-3.5 text-(--c-6b6c66)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, código ou CNPJ"
            aria-label="Buscar por nome, código ou CNPJ"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--c-6b6c66)"
          />
        </div>
        <div className="flex gap-1 rounded-[7px] bg-(--c-f3f3f0) p-0.5" role="tablist">
          {filters.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-[5px] px-2.5 py-[5px] text-xs whitespace-nowrap",
                filter === key ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
              )}
            >
              {label} <span className="font-mono text-(--c-6b6c66)">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={<Building2 />} title="Nenhum cliente encontrado" />
      ) : (
        <>
          <div
            className={cn(
              ROW_GRID,
              "border-b border-(--c-efefeb) bg-(--c-fafaf8) px-4 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
            )}
          >
            <span>Cliente</span>
            <span className="hidden md:block">CNPJ / IE</span>
            <span className="hidden md:block">Certificado</span>
            <span className="text-right md:text-left">Última automação</span>
          </div>
          {filtered.map((r) => (
            <Link
              key={r.id}
              href={`/clients/${r.id}`}
              className={cn(
                ROW_GRID,
                "items-center border-b border-(--c-f2f2ef) px-4 py-2.5 text-foreground last:border-b-0 hover:bg-(--c-fafaf8) hover:no-underline",
                !r.active && "opacity-60",
              )}
            >
              <div className="flex min-w-0 flex-col gap-px">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{r.trade_name || r.legal_name}</span>
                  {!r.active ? (
                    <span className="shrink-0 rounded bg-(--c-f1f1ef) px-1.5 py-px text-[10.5px] text-(--c-6b6b66)">Inativo</span>
                  ) : null}
                </span>
                <span className="truncate text-[11.5px] text-(--c-6b6c66)">
                  <span className="font-mono">{r.client_code}</span>
                  {r.trade_name ? ` · ${r.legal_name}` : ""}
                </span>
              </div>
              <div className="hidden flex-col gap-px md:flex">
                <span className="font-mono text-[12.5px] text-(--c-4a4b46)">{formatCNPJ(r.cnpj)}</span>
                <span className="font-mono text-[11px] text-(--c-6b6c66)">IE {r.state_registration ?? "—"}</span>
              </div>
              <div className="hidden md:block">
                <CertificateCell status={r.certificate_status} validUntil={r.certificate_valid_until} />
              </div>
              <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
                {r.last_job ? (
                  <>
                    <JobStatusBadge status={r.last_job.status as JobStatus} />
                    <span className="text-[11px] whitespace-nowrap text-(--c-6b6c66)">
                      {formatCompetence(r.last_job.competence)} · {formatRelative(r.last_job.created_at)}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-(--c-6b6c66)">Nunca</span>
                )}
              </div>
            </Link>
          ))}
        </>
      )}
    </section>
  );
}
