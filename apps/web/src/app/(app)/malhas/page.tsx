import type { Metadata } from "next";

import { HelpTip } from "@/components/list-extras";
import { MalhasBoard } from "@/components/malhas/malhas-board";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { formatBRL, type MalhaCheckJob } from "@/lib/malhas";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { MalhaCheck } from "@/lib/types";

export const metadata: Metadata = { title: "Consulta de Malhas" };

export default async function MalhasPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [clients, checksRes, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase.from("malha_checks").select("*").limit(5000),
    supabase
      .from("automation_jobs")
      .select("id, client_id, status, created_at, last_message, error_message")
      .contains("operations", ["MALHA_CHECK"])
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  // empresas só de serviço (sem SIAT) ficam fora da consulta de malhas
  const active = new Set(clients.filter((c) => c.active && c.uses_siat).map((c) => c.id));
  const checks = ((checksRes.data ?? []) as MalhaCheck[]).filter((c) => active.has(c.client_id));
  const totalIcms = checks.reduce((n, c) => n + (c.total > 0 ? Number(c.icms_total ?? 0) : 0), 0);

  return (
    <>
      <PageHeader
        title="Consulta de Malhas"
        help={
          <HelpTip>
            <p>
              O robô entra no SIAT de cada cliente, abre Autoatendimento › Malhas Fiscais › Consulta de Malhas, confere a
              inscrição estadual e lê as tabelas DIEF/PGDAS e EFD/OIE: malha, períodos, ICMS e quantidade de NF-e. Só
              leitura: nada é alterado. Peça de novo quando quiser atualizar.
            </p>
            <p>
              Malhas intimadas pelo DT-e não aparecem nesta página do SIAT; para essas, veja o e-AGEAT › Malhas Fiscais ›
              Manifestação do Contribuinte.
            </p>
          </HelpTip>
        }
        actions={
          totalIcms > 0 ? (
            <span className="text-[13px] whitespace-nowrap text-(--c-4a4b46)">
              ICMS nas malhas em aberto:{" "}
              <b className="font-mono text-sm font-semibold text-(--c-b42323)">{formatBRL(totalIcms)}</b>
            </span>
          ) : null
        }
      />
      <MalhasBoard
        canRun={can(profile.role, "automation:run")}
        noSiat={clients
          .filter((c) => c.active && !c.uses_siat)
          .map((c) => ({ id: c.id, client_code: c.client_code, name: c.trade_name || c.legal_name }))}
        clients={clients
          .filter((c) => c.active && c.uses_siat)
          .map((c) => ({
            id: c.id,
            client_code: c.client_code,
            name: c.trade_name || c.legal_name,
            legal_name: c.legal_name,
            cnpj: c.cnpj,
            certificate_ok: c.certificate_status === "valid" || c.certificate_status === "expiring",
          }))}
        checks={checks}
        jobs={(jobsRes.data ?? []) as MalhaCheckJob[]}
      />
    </>
  );
}
