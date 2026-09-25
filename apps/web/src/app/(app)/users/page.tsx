import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { UsersManager } from "@/components/users/users-manager";
import { requirePermission } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

export const metadata: Metadata = { title: "Usuários" };

export default async function UsersPage() {
  const { profile } = await requirePermission("users:manage");
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("*").order("name");
  return (
    <>
      <PageHeader title="Usuários" description="Controle de acesso: Administrador, Operador e Visualizador." />
      <UsersManager users={(data ?? []) as Profile[]} selfId={profile.id} />
    </>
  );
}
