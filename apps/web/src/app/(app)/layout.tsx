import { cookies } from "next/headers";

import { Header } from "@/components/layout/header";
import { PcWaitPopup } from "@/components/layout/pc-wait-popup";
import { NAV_COLLAPSED_KEY, NAV_STATE_COOKIE, parseFolderState, type NavCounts, type NavFeatures } from "@/components/layout/nav-items";
import { Sidebar } from "@/components/layout/sidebar";
import { SidebarFrame } from "@/components/layout/sidebar-state";
import { ThemeSync } from "@/components/theme/theme";
import { requireSession } from "@/lib/auth";
import { emitAccess, NFSE_EMIT_RELEASED } from "@/lib/nfse-emit";
import { createClient } from "@/lib/supabase/server";
import type { DashboardStats } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireSession();
  const supabase = await createClient();
  // a emissão aparece no menu para todos; com cadeado enquanto não é liberada para quem está vendo
  const [{ data }, emit] = await Promise.all([supabase.rpc("dashboard_stats"), supabase.rpc("nfse_emit_enabled")]);
  const features: NavFeatures = {
    nfseEmit: emitAccess({ released: NFSE_EMIT_RELEASED, officeEnabled: emit.data === true, isOwner: profile.is_platform_owner }),
  };
  const stats = (data ?? {}) as Partial<DashboardStats>;
  const n = (v?: number) => v ?? 0;
  const counts: NavCounts = {
    queue: n(stats.jobs_queued) + n(stats.jobs_processing) + n(stats.jobs_waiting_sefaz) + n(stats.jobs_manual),
    downloads: n(stats.downloads_available),
    clients: n(stats.clients_active),
  };
  const folderState = parseFolderState((await cookies()).get(NAV_STATE_COOKIE)?.value);

  return (
    <SidebarFrame initialCollapsed={folderState[NAV_COLLAPSED_KEY] === true}>
      <ThemeSync />
      <Sidebar
        role={profile.role}
        isOwner={profile.is_platform_owner}
        orgName={profile.organizations?.name ?? null}
        counts={counts}
        features={features}
        folderState={folderState}
      />
      <div
        data-sidebar-pad
        className="flex min-h-screen min-w-0 flex-col transition-[padding-left] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] lg:pl-(--sb-w)"
      >
        <Header profile={profile} counts={counts} features={features} folderState={folderState} />
        <main className="w-full max-w-[1360px] p-4 lg:p-6">{children}</main>
        <PcWaitPopup />
        <footer className="mt-auto w-full px-4 pt-2 pb-5 text-center text-xs text-muted-foreground lg:-ml-(--sb-w) lg:w-[calc(100%+var(--sb-w))]">
          JR Sistema © {new Date().getFullYear()}
        </footer>
      </div>
    </SidebarFrame>
  );
}
