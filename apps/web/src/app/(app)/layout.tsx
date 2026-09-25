import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { requireSession } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireSession();
  return (
    <div className="min-h-screen bg-background">
      <Sidebar role={profile.role} />
      <div className="lg:pl-60">
        <Header profile={profile} />
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
