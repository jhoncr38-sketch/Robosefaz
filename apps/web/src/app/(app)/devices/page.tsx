import type { Metadata } from "next";

import { DevicesManager } from "@/components/devices/devices-manager";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { Device } from "@/lib/types";

export const metadata: Metadata = { title: "Computadores" };

export default async function DevicesPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const { data } = await supabase
    .from("devices")
    .select("*")
    .eq("org_id", profile.org_id ?? "")
    .order("status")
    .order("activated_at", { ascending: false });

  return (
    <>
      <PageHeader
        title="Computadores"
        description="Computadores onde o robô do escritório roda. Cada um é ativado com um código e só acessa os dados deste escritório."
      />
      <DevicesManager
        devices={(data ?? []) as Device[]}
        canManage={can(profile.role, "users:manage")}
        now={new Date().getTime()}
      />
    </>
  );
}
