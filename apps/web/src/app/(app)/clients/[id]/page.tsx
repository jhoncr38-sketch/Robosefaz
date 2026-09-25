import { ArrowLeft, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { RunAutomationDialog } from "@/components/automation/run-automation-dialog";
import { CertificateFormDialog } from "@/components/certificates/certificate-form-dialog";
import {
  ChromePolicyDialog,
  DeactivateCertificateButton,
  OpenProfileButton,
  SecretDialog,
} from "@/components/certificates/certificate-actions";
import { ClientFormDialog } from "@/components/clients/client-form-dialog";
import { DownloadsTable } from "@/components/downloads-table";
import { JobsTable } from "@/components/jobs-table";
import { EmptyState } from "@/components/page-header";
import { CertificateStatusBadge, ToneBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireSession } from "@/lib/auth";
import { formatCNPJ } from "@/lib/cnpj";
import { daysUntil, formatDateTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { JOB_SELECT, loadProfilesMap } from "@/lib/queries";
import { certificateStatusFromDate, EXPORT_OPERATIONS, FINAL_JOB_STATUSES } from "@/lib/status";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog, AutomationJob, Certificate, Client, DownloadRow } from "@/lib/types";

export const metadata: Metadata = { title: "Cliente" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{children || "—"}</div>
    </div>
  );
}

export default async function ClientDetailPage({ params }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const { profile } = await requireSession();
  const supabase = await createClient();

  const { data: client } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) notFound();
  const c = client as Client;

  const [certRes, jobsRes, downloadsRes, auditRes, users] = await Promise.all([
    supabase.from("certificates").select("*").eq("client_id", id).order("created_at", { ascending: false }),
    supabase.from("automation_jobs").select(JOB_SELECT).eq("client_id", id).order("created_at", { ascending: false }).limit(100),
    supabase.from("downloads").select("*").eq("client_id", id).order("downloaded_at", { ascending: false }),
    can(profile.role, "audit:read")
      ? supabase.from("audit_logs").select("*").eq("client_id", id).order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
    loadProfilesMap(),
  ]);

  const certificates = (certRes.data ?? []) as Certificate[];
  const active = certificates.find((x) => x.active) ?? null;
  const jobs = (jobsRes.data ?? []) as AutomationJob[];
  const running = jobs.filter((j) => !FINAL_JOB_STATUSES.includes(j.status));
  const downloads = (downloadsRes.data ?? []) as DownloadRow[];
  const audits = (auditRes.data ?? []) as AuditLog[];
  const admin = can(profile.role, "clients:write");
  const clientOption = [{ id: c.id, label: c.trade_name || c.legal_name, cnpj: c.cnpj }];
  const certStatus = active ? certificateStatusFromDate(active.valid_until) : null;

  return (
    <>
      <Link href="/clients" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Clientes
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{c.legal_name}</h1>
            <ToneBadge tone={c.active ? "green" : "gray"}>{c.active ? "Ativo" : "Inativo"}</ToneBadge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {c.client_code} · <span className="font-mono">{formatCNPJ(c.cnpj)}</span>
            {c.trade_name ? ` · ${c.trade_name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {admin ? <ClientFormDialog client={c} /> : null}
          {can(profile.role, "automation:run") ? (
            <RunAutomationDialog
              client={c}
              canForce={can(profile.role, "automation:force")}
              disabled={!c.active}
            />
          ) : null}
        </div>
      </div>

      {!active ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <ShieldAlert className="size-4" /> Cliente sem certificado ativo: as automações ficarão com status “Certificado necessário”.
        </div>
      ) : null}

      <Tabs defaultValue="data">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="data">Dados</TabsTrigger>
          <TabsTrigger value="certificate">Certificado</TabsTrigger>
          <TabsTrigger value="automations">Automações ({running.length})</TabsTrigger>
          <TabsTrigger value="downloads">Downloads ({downloads.length})</TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
          <TabsTrigger value="siat">Configurações SIAT</TabsTrigger>
        </TabsList>

        <TabsContent value="data">
          <Card>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Razão social">{c.legal_name}</Field>
              <Field label="Nome fantasia">{c.trade_name}</Field>
              <Field label="CNPJ"><span className="font-mono">{formatCNPJ(c.cnpj)}</span></Field>
              <Field label="Inscrição estadual">{c.state_registration}</Field>
              <Field label="UF">{c.uf}</Field>
              <Field label="E-mail">{c.email}</Field>
              <Field label="Telefone">{c.phone}</Field>
              <Field label="Código interno">{c.client_code}</Field>
              <Field label="Cadastrado em">{formatDateTime(c.created_at)}</Field>
              <Field label="Atualizado em">{formatDateTime(c.updated_at)}</Field>
              <div className="sm:col-span-2">
                <Field label="Observações">{c.notes}</Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="certificate" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Certificado ativo</CardTitle>
              {admin ? (
                <div className="flex flex-wrap gap-2">
                  <CertificateFormDialog clientId={c.id} clients={clientOption} />
                  <OpenProfileButton clientId={c.id} />
                </div>
              ) : null}
            </CardHeader>
            <CardContent>
              {active ? (
                <div className="space-y-5">
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Titular">{active.subject_name}</Field>
                    <Field label="Emissor">{active.issuer}</Field>
                    <Field label="Tipo">{active.type}</Field>
                    <Field label="Número de série"><span className="font-mono text-xs">{active.serial_number}</span></Field>
                    <Field label="Thumbprint"><span className="font-mono text-xs">{active.thumbprint}</span></Field>
                    <Field label="Validade">
                      <span className="flex items-center gap-2">
                        {formatDateTime(active.valid_until)}
                        {certStatus ? <CertificateStatusBadge status={certStatus} /> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {(daysUntil(active.valid_until) ?? 0) > 0 ? `${daysUntil(active.valid_until)} dia(s) restantes` : "Vencido"}
                      </span>
                    </Field>
                    <Field label="Perfil do navegador">
                      <span className="font-mono text-xs">storage/browser_profiles/{active.browser_profile}/</span>
                    </Field>
                    <Field label="Seleção do certificado">
                      {active.requires_manual_selection ? "Manual (usuário escolhe)" : "Automática quando inequívoca"}
                    </Field>
                    <Field label="Senha no cofre">{active.has_secret ? "Sim" : "Não"}</Field>
                  </div>
                  {admin ? (
                    <div className="flex flex-wrap gap-2 border-t pt-4">
                      <CertificateFormDialog certificate={active} clients={clientOption} />
                      <SecretDialog certificate={active} />
                      <ChromePolicyDialog certificate={active} />
                      <DeactivateCertificateButton certificate={active} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <EmptyState title="Nenhum certificado ativo" description="Associe o certificado A1 instalado na máquina do worker." />
              )}
            </CardContent>
          </Card>
          {certificates.filter((x) => !x.active).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Certificados anteriores</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {certificates
                  .filter((x) => !x.active)
                  .map((x) => (
                    <div key={x.id} className="flex justify-between gap-3 border-b pb-2 last:border-0">
                      <span className="truncate">{x.subject_name}</span>
                      <span className="shrink-0 text-muted-foreground">até {formatDateTime(x.valid_until)}</span>
                    </div>
                  ))}
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="automations">
          <Card className="py-0">
            <CardContent className="p-0">
              <JobsTable jobs={running} showClient={false} users={users} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="downloads">
          <Card className="py-0">
            <CardContent className="p-0">
              <DownloadsTable rows={downloads} showClient={false} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <Card className="py-0">
            <CardContent className="p-0">
              <JobsTable jobs={jobs} showClient={false} users={users} />
            </CardContent>
          </Card>
          {audits.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Auditoria</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {audits.map((a) => (
                  <div key={a.id} className="flex flex-wrap justify-between gap-2 border-b pb-2 last:border-0">
                    <span>
                      <span className="font-medium">{a.action}</span>
                      <span className="text-muted-foreground"> · {a.user_id ? users[a.user_id] ?? a.user_id : "Sistema"}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(a.created_at)}
                      {a.ip ? ` · IP ${a.ip}` : ""}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="siat">
          <Card>
            <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {EXPORT_OPERATIONS.map((o) => (
                <Field key={o.value} label={o.label}>
                  <ToneBadge tone={c[o.flag] ? "green" : "gray"}>{c[o.flag] ? "Habilitado" : "Desabilitado"}</ToneBadge>
                </Field>
              ))}
              <Field label="Portal">{c.provider}</Field>
              <Field label="Validação do contribuinte">
                CNPJ {formatCNPJ(c.cnpj)}
                {c.state_registration ? ` · IE ${c.state_registration}` : ""}
              </Field>
              <div className="sm:col-span-2 text-xs text-muted-foreground">
                Antes de agendar ou baixar, o robô confirma que o contribuinte aberto no SIAT corresponde a este CNPJ. Em
                caso de divergência a sessão é encerrada (SECURITY_CLIENT_MISMATCH).
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
