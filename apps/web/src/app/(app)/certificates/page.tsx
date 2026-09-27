import { Pencil, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CertificateFormDialog } from "@/components/certificates/certificate-form-dialog";
import {
  ChromePolicyDialog,
  DeactivateCertificateButton,
  SecretDialog,
} from "@/components/certificates/certificate-actions";
import { ListCard, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { CertificateStatusBadge, ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";
import { daysUntil, formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import { certificateStatusFromDate } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { Certificate } from "@/lib/types";

export const metadata: Metadata = { title: "Certificados" };

// sem rolagem lateral: no celular, cliente e status; titular e senha em telas largas
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1.2fr)_120px_110px] xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_120px_110px_130px]";

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
      <ListCard>
        {rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="Nenhum certificado associado" description="Associe o certificado A1 de cada cliente." />
        ) : (
          <>
            <ListHead grid={GRID}>
              <span>Cliente</span>
              <span className="hidden xl:block">Titular</span>
              <span className="hidden md:block">Validade</span>
              <span className="text-right md:text-left">Status</span>
              <span className="hidden xl:block">Senha / perfil</span>
            </ListHead>
            {rows.map((c) => {
              const status = c.active ? certificateStatusFromDate(c.valid_until) : null;
              const days = daysUntil(c.valid_until);
              return (
                <div key={c.id} className={c.active ? undefined : "opacity-60"}>
                  <ListRow grid={GRID} className={admin ? "border-b-0 pb-1.5" : undefined}>
                    <PrimaryCell
                      title={
                        <Link href={`/clients/${c.client_id}`} className="text-foreground hover:underline">
                          {c.clients?.trade_name || c.clients?.legal_name}
                        </Link>
                      }
                      sub={
                        <>
                          <span className="font-mono">{c.clients?.client_code}</span> · {c.type}
                          <span className="md:hidden"> · até {formatDate(c.valid_until)}</span>
                        </>
                      }
                    />
                    <div className="hidden min-w-0 flex-col gap-px xl:flex">
                      <span className="truncate text-xs" title={c.subject_name}>
                        {c.subject_name}
                      </span>
                      <span className="truncate text-[11px] text-[#9a9b94]">
                        {c.issuer ?? "—"}
                        {c.serial_number ? ` · série ${c.serial_number}` : ""}
                      </span>
                    </div>
                    <div className="hidden flex-col gap-px md:flex">
                      <span className="text-xs tabular-nums">{formatDate(c.valid_until)}</span>
                      {c.active && days !== null ? (
                        <span className="text-[11px] text-[#9a9b94]">{days > 0 ? `${days} dia(s)` : "vencido"}</span>
                      ) : null}
                    </div>
                    <div className="flex justify-end md:justify-start">
                      {status ? <CertificateStatusBadge status={status} /> : <ToneBadge tone="gray">Inativo</ToneBadge>}
                    </div>
                    <div className="hidden flex-col items-start gap-0.5 xl:flex">
                      <ToneBadge tone={c.has_secret ? "green" : "gray"}>{c.has_secret ? "Senha no cofre" : "Sem senha"}</ToneBadge>
                      {c.requires_manual_selection ? (
                        <span className="text-[11px] text-[#b4530f]">seleção manual</span>
                      ) : c.browser_profile ? (
                        <span className="font-mono text-[11px] text-[#9a9b94]">perfil {c.browser_profile.slice(0, 8)}…</span>
                      ) : null}
                    </div>
                  </ListRow>
                  {admin ? (
                    <div className="flex flex-wrap justify-end gap-1.5 border-b border-[#f2f2ef] px-4 pb-2.5">
                      <CertificateFormDialog
                        certificate={c}
                        clients={clientOptions}
                        trigger={
                          <Button variant="outline" size="sm">
                            <Pencil /> Editar
                          </Button>
                        }
                      />
                      {c.active ? <SecretDialog certificate={c} /> : null}
                      {c.active ? <ChromePolicyDialog certificate={c} /> : null}
                      <DeactivateCertificateButton certificate={c} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        )}
      </ListCard>
    </>
  );
}
