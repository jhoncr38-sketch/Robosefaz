import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CertificateFormDialog } from "@/components/certificates/certificate-form-dialog";
import {
  ChromePolicyDialog,
  DeactivateCertificateButton,
  SecretDialog,
} from "@/components/certificates/certificate-actions";
import { EmptyState, PageHeader } from "@/components/page-header";
import { CertificateStatusBadge, ToneBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireSession } from "@/lib/auth";
import { daysUntil, formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { certificateStatusFromDate } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { Certificate } from "@/lib/types";

export const metadata: Metadata = { title: "Certificados" };

type Row = Certificate & { clients: { legal_name: string; trade_name: string | null; client_code: string; cnpj: string } | null };

export default async function CertificatesPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [certRes, clientRes] = await Promise.all([
    supabase
      .from("certificates")
      .select("*, clients(legal_name, trade_name, client_code, cnpj)")
      .order("active", { ascending: false })
      .order("valid_until"),
    supabase.from("clients").select("id, legal_name, trade_name, cnpj").order("legal_name"),
  ]);
  const rows = (certRes.data ?? []) as Row[];
  const clientOptions = (clientRes.data ?? []).map((c) => ({ id: c.id, label: c.trade_name || c.legal_name, cnpj: c.cnpj }));
  const admin = can(profile.role, "certificates:write");

  return (
    <>
      <PageHeader
        title="Certificados"
        description="Certificados digitais por cliente, validade e perfil de navegador exclusivo."
        actions={admin ? <CertificateFormDialog clients={clientOptions} /> : null}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        {rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="Nenhum certificado associado" description="Associe o certificado A1 de cada cliente." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Titular</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Série</TableHead>
                <TableHead>Validade</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Perfil</TableHead>
                <TableHead>Senha</TableHead>
                {admin ? <TableHead className="text-right">Ações</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const status = c.active ? certificateStatusFromDate(c.valid_until) : null;
                const days = daysUntil(c.valid_until);
                return (
                  <TableRow key={c.id} className={c.active ? undefined : "opacity-60"}>
                    <TableCell>
                      <Link href={`/clients/${c.client_id}`} className="font-medium hover:underline">
                        {c.clients?.trade_name || c.clients?.legal_name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{c.clients?.client_code}</p>
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-xs" title={c.subject_name}>
                      {c.subject_name}
                      {c.issuer ? <p className="truncate text-muted-foreground">{c.issuer}</p> : null}
                    </TableCell>
                    <TableCell>{c.type}</TableCell>
                    <TableCell className="font-mono text-xs">{c.serial_number ?? "—"}</TableCell>
                    <TableCell className="text-sm">
                      {formatDate(c.valid_until)}
                      {c.active && days !== null ? (
                        <p className="text-xs text-muted-foreground">{days > 0 ? `${days} dia(s)` : "vencido"}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {status ? <CertificateStatusBadge status={status} /> : <ToneBadge tone="gray">Inativo</ToneBadge>}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {c.browser_profile ? `${c.browser_profile.slice(0, 8)}…` : "—"}
                      {c.requires_manual_selection ? <p className="font-sans text-orange-700">seleção manual</p> : null}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={c.has_secret ? "green" : "gray"}>{c.has_secret ? "No cofre" : "Não"}</ToneBadge>
                    </TableCell>
                    {admin ? (
                      <TableCell>
                        <div className="flex justify-end gap-1.5">
                          <CertificateFormDialog certificate={c} clients={clientOptions} />
                          {c.active ? <SecretDialog certificate={c} /> : null}
                          {c.active ? <ChromePolicyDialog certificate={c} /> : null}
                          <DeactivateCertificateButton certificate={c} />
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
