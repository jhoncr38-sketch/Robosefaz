"use client";

import { Building2, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/page-header";
import { CertificateStatusBadge, JobStatusBadge, ToneBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCNPJ, normalizeCNPJ } from "@/lib/cnpj";
import { formatCompetence } from "@/lib/competence";
import { formatDate, formatRelative } from "@/lib/format";
import type { CertificateStatus, JobStatus } from "@/lib/types";

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

export function ClientsTable({ rows }: { rows: ClientRow[] }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    const digits = normalizeCNPJ(term).toLowerCase();
    return rows.filter(
      (r) =>
        r.legal_name.toLowerCase().includes(term) ||
        (r.trade_name ?? "").toLowerCase().includes(term) ||
        r.client_code.toLowerCase().includes(term) ||
        (digits.length >= 3 && r.cnpj.toLowerCase().includes(digits)),
    );
  }, [q, rows]);

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Buscar por nome, código ou CNPJ" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        {filtered.length === 0 ? (
          <EmptyState icon={<Building2 />} title="Nenhum cliente encontrado" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Razão social</TableHead>
                <TableHead>Nome fantasia</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Inscrição estadual</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Certificado</TableHead>
                <TableHead>Validade</TableHead>
                <TableHead>Última automação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/clients/${r.id}`} className="font-medium hover:underline">
                      {r.legal_name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{r.client_code}</p>
                  </TableCell>
                  <TableCell className="text-sm">{r.trade_name ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{formatCNPJ(r.cnpj)}</TableCell>
                  <TableCell className="text-sm">{r.state_registration ?? "—"}</TableCell>
                  <TableCell>
                    <ToneBadge tone={r.active ? "green" : "gray"}>{r.active ? "Ativo" : "Inativo"}</ToneBadge>
                  </TableCell>
                  <TableCell>
                    {r.certificate_status ? (
                      <CertificateStatusBadge status={r.certificate_status} />
                    ) : (
                      <span className="text-xs text-red-600">Não configurado</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{formatDate(r.certificate_valid_until)}</TableCell>
                  <TableCell>
                    {r.last_job ? (
                      <div className="space-y-0.5">
                        <JobStatusBadge status={r.last_job.status as JobStatus} />
                        <p className="text-[11px] text-muted-foreground">
                          {formatCompetence(r.last_job.competence)} · {formatRelative(r.last_job.created_at)}
                        </p>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Nunca</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
