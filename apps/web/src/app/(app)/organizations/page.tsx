import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { OrganizationsManager } from "@/components/organizations/organizations-manager";
import { PlatformHealth } from "@/components/organizations/platform-health";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requirePlatformOwner } from "@/lib/auth";
import type { PlatformHealthRow } from "@/lib/health";
import { createClient } from "@/lib/supabase/server";
import type { PlatformOrganization } from "@/lib/types";

export const metadata: Metadata = { title: "Escritórios" };

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const { profile } = await requirePlatformOwner();
  const { aba } = await searchParams;
  const supabase = await createClient();
  const [orgs, health] = await Promise.all([supabase.rpc("platform_organizations"), supabase.rpc("platform_health")]);

  return (
    <>
      <PageHeader
        title="Escritórios"
        description="Os escritórios que usam o sistema e a saúde dos robôs de cada um. Cada escritório vê somente os próprios clientes, notas e usuários."
      />
      <Alert className="mb-4">
        <ShieldCheck />
        <AlertDescription>
          Aqui aparecem apenas números de cada escritório. Por privacidade (LGPD), nem o dono da plataforma enxerga os
          clientes e as notas dos outros escritórios.
        </AlertDescription>
      </Alert>
      <Tabs defaultValue={aba === "escritorios" ? "escritorios" : "saude"}>
        <TabsList>
          <TabsTrigger value="saude">Saúde</TabsTrigger>
          <TabsTrigger value="escritorios">Escritórios</TabsTrigger>
        </TabsList>
        <TabsContent value="saude" className="mt-2">
          {health.error ? (
            <p className="text-sm text-destructive">Não foi possível carregar a saúde: {health.error.message}</p>
          ) : (
            <PlatformHealth rows={(health.data ?? []) as PlatformHealthRow[]} />
          )}
        </TabsContent>
        <TabsContent value="escritorios" className="mt-2">
          {orgs.error ? (
            <p className="text-sm text-destructive">Não foi possível carregar os escritórios: {orgs.error.message}</p>
          ) : (
            <OrganizationsManager orgs={(orgs.data ?? []) as PlatformOrganization[]} ownOrgId={profile.org_id} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
