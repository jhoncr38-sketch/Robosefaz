"use client";

import { FileArchive } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/components/layout/nav-items";
import { can } from "@/lib/permissions";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SidebarNav({
  role,
  isOwner = false,
  onNavigate,
}: {
  role: UserRole;
  isOwner?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.filter(
        (item) => (!item.permission || can(role, item.permission)) && (!item.ownerOnly || isOwner),
      ).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <FileArchive className="size-4" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold">SIAT Automação</p>
        <p className="text-[11px] text-muted-foreground">SEFAZ-PI</p>
      </div>
    </Link>
  );
}

export function Sidebar({ role, isOwner, orgName }: { role: UserRole; isOwner: boolean; orgName: string | null }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar lg:flex">
      <div className="flex h-14 items-center border-b">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav role={role} isOwner={isOwner} />
      </div>
      <div className="border-t px-5 py-3">
        <p className="truncate text-xs font-medium" title={orgName ?? undefined}>
          {orgName ?? "Sem escritório"}
        </p>
        <p className="text-[11px] text-muted-foreground">{isOwner ? "Dono da plataforma" : "Escritório"}</p>
      </div>
    </aside>
  );
}
