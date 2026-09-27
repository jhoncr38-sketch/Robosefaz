import type { Metadata } from "next";

import { ClientFormDialog } from "@/components/clients/client-form-dialog";
import { ClientsTable, type ClientRow } from "@/components/clients/clients-table";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { activeCertificate, loadClientsWithCertificates, loadLastJobByClient } from "@/lib/queries";
import { certificateStatusFromDate } from "@/lib/status";

export const metadata: Metadata = { title: "Clientes" };

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const { profile } = await requireSession();
  const { q } = await searchParams;
  const [clients, lastJobs] = await Promise.all([loadClientsWithCertificates(), loadLastJobByClient()]);

  const rows: ClientRow[] = clients.map((c) => {
    const cert = activeCertificate(c.certificates);
    return {
      id: c.id,
      client_code: c.client_code,
      legal_name: c.legal_name,
      trade_name: c.trade_name,
      cnpj: c.cnpj,
      state_registration: c.state_registration,
      active: c.active,
      certificate_status: cert ? certificateStatusFromDate(cert.valid_until) : null,
      certificate_valid_until: cert?.valid_until ?? null,
      last_job: lastJobs[c.id] ?? null,
    };
  });

  return (
    <>
      <PageHeader
        title="Clientes"
        description={`${rows.length} empresa(s) cadastrada(s).`}
        actions={can(profile.role, "clients:write") ? <ClientFormDialog /> : null}
      />
      {/* a busca do cabeçalho (Ctrl+K) chega aqui como ?q= */}
      <ClientsTable key={typeof q === "string" ? q : ""} rows={rows} initialQuery={typeof q === "string" ? q : ""} />
    </>
  );
}
