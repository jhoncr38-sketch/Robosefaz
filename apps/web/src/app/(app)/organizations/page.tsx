import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { OrganizationsManager } from "@/components/organizations/organizations-manager";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requirePlatformOwner } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { PlatformOrganization } from "@/lib/types";

export const metadata: Metadata = { title: "Escritórios" };

export default async function OrganizationsPage() {
  const { profile } = await requirePlatformOwner();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_organizations");

  return (
    <>
      <PageHeader
        title="Escritórios"
        description="Os escritórios que usam o sistema. Cada um vê somente os próprios clientes, notas e usuários."
      />
      <Alert className="mb-4">
        <ShieldCheck />
        <AlertDescription>
          Aqui aparecem apenas números de cada escritório. Por privacidade (LGPD), nem o dono da plataforma enxerga os
          clientes e as notas dos outros escritórios.
        </AlertDescription>
      </Alert>
      {error ? (
        <p className="text-sm text-destructive">Não foi possível carregar os escritórios: {error.message}</p>
      ) : (
        <OrganizationsManager orgs={(data ?? []) as PlatformOrganization[]} ownOrgId={profile.org_id} />
      )}
    </>
  );
}
