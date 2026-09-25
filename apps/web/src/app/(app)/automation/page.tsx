import { Info } from "lucide-react";
import type { Metadata } from "next";

import { AutomationPlanner } from "@/components/automation/automation-planner";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { loadPlannerClients } from "@/lib/queries";

export const metadata: Metadata = { title: "Automação SIAT" };

export default async function AutomationPage() {
  const { profile } = await requirePermission("automation:run");
  const clients = await loadPlannerClients();
  return (
    <>
      <PageHeader
        title="Automação SIAT"
        description="Agende a exportação de NFC-e e NF-e (emitidas e recebidas) de uma competência para vários clientes."
      />
      <Alert className="mb-5 border-sky-200 bg-sky-50 text-sky-900">
        <Info className="text-sky-600" />
        <AlertTitle>Como funciona</AlertTitle>
        <AlertDescription className="text-sky-900/90">
          O robô processa um cliente por vez, com o perfil de navegador e o certificado de cada empresa. Após o
          agendamento, o navegador é fechado e o Collector consulta a SEFAZ periodicamente até baixar os ZIPs.
          Solicitações já existentes para a mesma competência não são repetidas.
        </AlertDescription>
      </Alert>
      <AutomationPlanner clients={clients} canForce={can(profile.role, "automation:force")} />
    </>
  );
}
