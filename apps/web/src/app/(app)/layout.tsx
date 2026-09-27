import { Header } from "@/components/layout/header";
import type { NavCounts } from "@/components/layout/nav-items";
import { Sidebar } from "@/components/layout/sidebar";
import { ThemeSync } from "@/components/theme/theme";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { DashboardStats } from "@/lib/types";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const { data } = await supabase.rpc("dashboard_stats");
  const stats = (data ?? {}) as Partial<DashboardStats>;
  const n = (v?: number) => v ?? 0;
  const counts: NavCounts = {
    queue: n(stats.jobs_queued) + n(stats.jobs_processing) + n(stats.jobs_waiting_sefaz) + n(stats.jobs_manual),
    downloads: n(stats.downloads_available),
    clients: n(stats.clients_active),
  };

  return (
    <div className="min-h-screen bg-background">
      <ThemeSync />
      <Sidebar
        role={profile.role}
        isOwner={profile.is_platform_owner}
        orgName={profile.organizations?.name ?? null}
        counts={counts}
      />
      <div className="flex min-h-screen min-w-0 flex-col lg:pl-[232px]">
        <Header profile={profile} counts={counts} />
        <main className="w-full max-w-[1360px] p-4 lg:p-6">{children}</main>
        <footer className="mt-auto w-full px-4 pt-2 pb-5 text-center text-xs text-muted-foreground lg:-ml-[232px] lg:w-[calc(100%+232px)]">
          JR Sistema © {new Date().getFullYear()}
        </footer>
      </div>
    </div>
  );
}
