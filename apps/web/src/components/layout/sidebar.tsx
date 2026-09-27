"use client";

import { ChevronsUpDown, FileArchive } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_GROUPS, type NavCounts } from "@/components/layout/nav-items";
import { can } from "@/lib/permissions";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SidebarNav({
  role,
  isOwner = false,
  counts,
  onNavigate,
}: {
  role: UserRole;
  isOwner?: boolean;
  counts?: NavCounts;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-2 px-2.5">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter(
          (item) => (!item.permission || can(role, item.permission)) && (!item.ownerOnly || isOwner),
        );
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p className="px-2.5 py-1 text-[10.5px] font-medium tracking-[0.06em] text-[#9a9b94] uppercase">
              {group.label}
            </p>
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              const badge = item.badge && counts ? counts[item.badge] : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13.5px] transition-colors",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-[#f2f3ef]",
                  )}
                >
                  <Icon className="size-[15px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span
                      className={cn(
                        "rounded-[10px] px-1.5 py-px font-mono text-[11px]",
                        item.badgeWarn ? "bg-[#fdf4e3] text-[#9a6205]" : "bg-[#f0f0ec] text-[#6b6c66]",
                      )}
                    >
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <FileArchive className="size-4" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold">SIAT Automação</p>
        <p className="text-[11px] text-[#7a7b75]">SEFAZ-PI</p>
      </div>
    </Link>
  );
}

function OfficeFooter({ orgName, isOwner }: { orgName: string | null; isOwner: boolean }) {
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[12.5px] font-medium" title={orgName ?? undefined}>
          {orgName ?? "Sem escritório"}
        </p>
        <p className="text-[11px] text-[#7a7b75]">{isOwner ? "Dono da plataforma" : "Escritório"}</p>
      </div>
      {isOwner ? <ChevronsUpDown className="size-3.5 text-[#9a9b94]" /> : null}
    </>
  );
  // só o dono da plataforma tem outros escritórios para ver
  return isOwner ? (
    <Link href="/organizations" className="flex items-center gap-2.5 border-t border-[#efefeb] px-4 py-3 hover:bg-[#fafaf8]">
      {body}
    </Link>
  ) : (
    <div className="flex items-center gap-2.5 border-t border-[#efefeb] px-4 py-3">{body}</div>
  );
}

export function Sidebar({
  role,
  isOwner,
  orgName,
  counts,
}: {
  role: UserRole;
  isOwner: boolean;
  orgName: string | null;
  counts: NavCounts;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r bg-sidebar lg:flex">
      <div className="border-b border-[#efefeb] px-4 pt-4 pb-3.5">
        <Brand />
      </div>
      <div className="no-scrollbar flex-1 overflow-x-hidden overflow-y-auto py-2">
        <SidebarNav role={role} isOwner={isOwner} counts={counts} />
      </div>
      <OfficeFooter orgName={orgName} isOwner={isOwner} />
    </aside>
  );
}
