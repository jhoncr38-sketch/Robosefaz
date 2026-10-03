import type { Metadata } from "next";

import { EfdBoard } from "@/components/efd/efd-board";
import { HelpTip } from "@/components/list-extras";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { currentCompetence, previousCompetence, toCompetenceKey } from "@/lib/competence";
import type { EfdCheckJob } from "@/lib/efd";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { EfdDeclaration } from "@/lib/types";

export const metadata: Metadata = { title: "Consulta EFD" };

export default async function EfdPage({ searchParams }: PageProps<"/efd">) {
  const { profile } = await requireSession();
  const params = await searchParams;
  const asked = typeof params.competence === "string" ? toCompetenceKey(params.competence) : null;
  const competence = asked && asked <= currentCompetence() ? asked : previousCompetence();

  const supabase = await createClient();
  const [clients, declsRes, jobsRes] = await Promise.all([
    loadPlannerClients(),
    supabase.from("efd_declarations").select("*").eq("competence", competence).limit(5000),
    supabase
      .from("automation_jobs")
      .select("id, client_id, status, created_at, last_message, error_message")
      .eq("competence", competence)
      .contains("operations", ["EFD_CHECK"])
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  return (
    <>
      <PageHeader
        title="Consulta EFD"
        help={
          <HelpTip>
            <p>
              O robô abre o Domicílio Eletrônico (DT-e) de cada cliente e lê só as notificações <b>EPE - EFD</b> da
              competência: finalidade, se foi processada e as inconsistências. Nenhuma outra mensagem é aberta e nada é
              excluído. O SIAT mantém essas mensagens por cerca de 60 dias.
            </p>
            <p>
              <b>Tipo 1 · Impeditiva:</b> EFD não processada, sem validade para a SEFAZ-PI. <b>Tipo 2 · Pendência:</b>{" "}
              processada; regularizar em até 45 dias. <b>Tipo 3 · Alerta:</b> processada; pode ir para malha.
            </p>
          </HelpTip>
        }
      />
      <EfdBoard
        key={competence}
        competence={competence}
        canRun={can(profile.role, "automation:run")}
        clients={clients
          .filter((c) => c.active)
          .map((c) => ({
            id: c.id,
            client_code: c.client_code,
            name: c.trade_name || c.legal_name,
            legal_name: c.legal_name,
            cnpj: c.cnpj,
            certificate_ok: c.certificate_status === "valid" || c.certificate_status === "expiring",
          }))}
        declarations={(declsRes.data ?? []) as EfdDeclaration[]}
        jobs={(jobsRes.data ?? []) as EfdCheckJob[]}
      />
    </>
  );
}
