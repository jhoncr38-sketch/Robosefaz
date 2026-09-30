"use client";

import { ChevronRight, ChevronsUpDown } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";

import {
  NAV_GROUPS,
  NAV_STATE_COOKIE,
  folderBadge,
  isActive,
  isFolder,
  parseFolderState,
  serializeFolderState,
  type NavCounts,
  type NavEntry,
  type NavFolder,
  type NavFolderState,
  type NavItem,
} from "@/components/layout/nav-items";
import { can } from "@/lib/permissions";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const EASE = "ease-[cubic-bezier(0.2,0.8,0.2,1)]";

// escolhas feitas nesta aba: o menu do celular monta depois do layout e precisa seguir as mesmas
const chosenThisTab = new Map<string, boolean>();

function saveFolderChoice(key: string, open: boolean) {
  chosenThisTab.set(key, open);
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${NAV_STATE_COOKIE}=`));
  const state = parseFolderState(hit ? decodeURIComponent(hit.slice(NAV_STATE_COOKIE.length + 1)) : "");
  state[key] = open;
  document.cookie = `${NAV_STATE_COOKIE}=${encodeURIComponent(serializeFolderState(state))}; path=/; max-age=31536000; samesite=lax`;
}

function Count({ value, warn, className }: { value: number; warn?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-[10px] px-1.5 py-px font-mono text-[11px] tabular-nums",
        warn ? "nav-badge-live bg-(--c-fdf4e3) text-(--c-9a6205)" : "bg-(--c-f0f0ec) text-(--c-6b6c66)",
        className,
      )}
    >
      {value}
    </span>
  );
}

/** Barrinha verde na borda do menu que marca onde você está. */
function ActiveBar({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-1/2 -left-2.5 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-transform duration-300",
        EASE,
        on ? "scale-y-100" : "scale-y-0",
      )}
    />
  );
}

function NavLink({
  item,
  active,
  counts,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  counts?: NavCounts;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const badge = item.badge && counts ? counts[item.badge] : 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13.5px] transition-colors duration-200",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-(--c-f2f3ef)",
      )}
    >
      <ActiveBar on={active} />
      <Icon
        className={cn("size-[15px] shrink-0 transition-transform duration-200", EASE, !active && "group-hover:scale-110")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate transition-transform duration-200",
          EASE,
          !active && "group-hover:translate-x-0.5",
        )}
      >
        {item.label}
      </span>
      {badge > 0 ? <Count value={badge} warn={item.badgeWarn} /> : null}
    </Link>
  );
}

function NavFolderEntry({
  folder,
  items,
  pathname,
  counts,
  folderState,
  onNavigate,
}: {
  folder: NavFolder;
  items: NavItem[];
  pathname: string;
  counts?: NavCounts;
  folderState: NavFolderState;
  onNavigate?: () => void;
}) {
  const regionId = useId();
  // escolha do usuário (cookie lido no layout, igual no servidor e na hidratação); sem escolha, o grupo
  // fica recolhido e abre sozinho quando a página atual é de um item dele
  const [choice, setChoice] = useState<boolean | undefined>(
    () => chosenThisTab.get(folder.key) ?? folderState[folder.key],
  );
  const inside = items.some((i) => isActive(i.href, pathname));
  const open = choice ?? inside;
  const total = folderBadge({ ...folder, children: items }, counts);
  const Icon = folder.icon;

  const toggle = () => {
    setChoice(!open);
    saveFolderChoice(folder.key, !open);
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={regionId}
        className={cn(
          "group relative flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13.5px] transition-colors duration-200",
          inside && !open
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-(--c-f2f3ef)",
          inside && open && "font-medium",
        )}
      >
        <ActiveBar on={inside && !open} />
        <Icon
          className={cn(
            "size-[15px] shrink-0 transition-[color,transform] duration-200",
            EASE,
            inside ? "text-primary" : "group-hover:scale-110",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{folder.label}</span>
        {total.value > 0 ? (
          <Count
            value={total.value}
            warn={total.warn}
            className={cn(
              "transition-[opacity,transform] duration-200",
              EASE,
              open ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100",
            )}
          />
        ) : null}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-(--c-9a9b94) transition-transform duration-300",
            EASE,
            open && "rotate-90",
          )}
        />
      </button>

      {/* grid 0fr -> 1fr: abre e fecha deslizando, sem medir altura */}
      <div
        id={regionId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300",
          EASE,
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        {/* overflow-hidden no ul corta a barrinha da borda: ela fica no li, que ocupa a largura toda */}
        <ul className="-ml-2.5 min-h-0 overflow-hidden pl-2.5">
          {items.map((item, i) => {
            const active = isActive(item.href, pathname);
            const badge = item.badge && counts ? counts[item.badge] : 0;
            return (
              <li
                key={item.href}
                style={{ transitionDelay: open ? `${60 + i * 40}ms` : "0ms" }}
                className={cn(
                  "relative transition-[opacity,transform] duration-300",
                  EASE,
                  open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
                )}
              >
                <ActiveBar on={active} />
                {/* texto alinhado com o nome do grupo (ícone 15px + espaço) */}
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group ml-[25px] flex items-center gap-2 rounded-[7px] px-2.5 py-[6px] text-[13px] transition-colors duration-200",
                    // sem negrito no ativo: "Fila de processamento" + contador não cabe em 232px
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-(--c-6b6c66) hover:bg-(--c-f2f3ef) hover:text-sidebar-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate transition-transform duration-200",
                      EASE,
                      !active && "group-hover:translate-x-0.5",
                    )}
                  >
                    {item.label}
                  </span>
                  {badge > 0 ? <Count value={badge} warn={item.badgeWarn} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function SidebarNav({
  role,
  isOwner = false,
  counts,
  folderState = {},
  onNavigate,
}: {
  role: UserRole;
  isOwner?: boolean;
  counts?: NavCounts;
  folderState?: NavFolderState;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const visible = (item: NavItem) => (!item.permission || can(role, item.permission)) && (!item.ownerOnly || isOwner);
  return (
    <nav data-nav className="flex flex-col gap-2 px-2.5">
      {NAV_GROUPS.map((group, gi) => {
        const entries = group.items.flatMap((entry): { entry: NavEntry; items: NavItem[] }[] => {
          if (!isFolder(entry)) return visible(entry) ? [{ entry, items: [] }] : [];
          const items = entry.children.filter(visible);
          return items.length ? [{ entry, items }] : [];
        });
        if (entries.length === 0) return null;
        return (
          <div key={group.label} className="nav-in flex flex-col gap-0.5" style={{ animationDelay: `${gi * 70}ms` }}>
            <p className="px-2.5 py-1 text-[10.5px] font-medium tracking-[0.06em] text-(--c-9a9b94) uppercase">
              {group.label}
            </p>
            {entries.map(({ entry, items }) =>
              isFolder(entry) ? (
                <NavFolderEntry
                  key={entry.key}
                  folder={entry}
                  items={items}
                  pathname={pathname}
                  counts={counts}
                  folderState={folderState}
                  onNavigate={onNavigate}
                />
              ) : (
                <NavLink
                  key={entry.href}
                  item={entry}
                  active={isActive(entry.href, pathname)}
                  counts={counts}
                  onNavigate={onNavigate}
                />
              ),
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 text-foreground hover:no-underline">
      <Image src="/brand/logo-mark.png" alt="" width={34} height={34} priority className="size-[34px]" />
      <div className="leading-tight">
        <p className="text-sm font-semibold">
          <span className="text-(--c-1fa37a)">JR</span> Sistema
        </p>
        <p className="text-[11px] text-(--c-7a7b75)">Automação SIAT · SEFAZ-PI</p>
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
        <p className="text-[11px] text-(--c-7a7b75)">{isOwner ? "Dono da plataforma" : "Escritório"}</p>
      </div>
      {isOwner ? <ChevronsUpDown className="size-3.5 text-(--c-9a9b94)" /> : null}
    </>
  );
  // só o dono da plataforma tem outros escritórios para ver
  return isOwner ? (
    <Link href="/organizations" className="flex items-center gap-2.5 border-t border-(--c-efefeb) px-4 py-3 hover:bg-(--c-fafaf8)">
      {body}
    </Link>
  ) : (
    <div className="flex items-center gap-2.5 border-t border-(--c-efefeb) px-4 py-3">{body}</div>
  );
}

export function Sidebar({
  role,
  isOwner,
  orgName,
  counts,
  folderState,
}: {
  role: UserRole;
  isOwner: boolean;
  orgName: string | null;
  counts: NavCounts;
  folderState: NavFolderState;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r bg-sidebar lg:flex">
      <div className="border-b border-(--c-efefeb) px-4 pt-4 pb-3.5">
        <Brand />
      </div>
      <div className="no-scrollbar flex-1 overflow-x-hidden overflow-y-auto py-2">
        <SidebarNav role={role} isOwner={isOwner} counts={counts} folderState={folderState} />
      </div>
      <OfficeFooter orgName={orgName} isOwner={isOwner} />
    </aside>
  );
}
