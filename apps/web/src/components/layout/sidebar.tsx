"use client";

import { ChevronRight, ChevronsUpDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";

import {
  NAV_GROUPS,
  folderBadge,
  isActive,
  isFolder,
  type NavCounts,
  type NavEntry,
  type NavFolder,
  type NavFolderState,
  type NavItem,
} from "@/components/layout/nav-items";
import { saveNavChoice, useSidebar } from "@/components/layout/sidebar-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { can } from "@/lib/permissions";
import type { UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

const EASE = "ease-[cubic-bezier(0.2,0.8,0.2,1)]";

// escolhas feitas nesta aba: o menu do celular monta depois do layout e precisa seguir as mesmas
const chosenThisTab = new Map<string, boolean>();

function saveFolderChoice(key: string, open: boolean) {
  chosenThisTab.set(key, open);
  saveNavChoice(key, open);
}

function Count({ value, warn, className }: { value: number; warn?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-[10px] px-1.5 py-px font-mono text-[11px] tabular-nums",
        warn ? "bg-(--sb-warn-bg) text-(--sb-warn-fg)" : "bg-(--sb-badge-bg) text-(--sb-badge-fg)",
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
        "absolute top-1/2 -left-2.5 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-(--sb-bar) transition-transform duration-300",
        EASE,
        on ? "scale-y-100" : "scale-y-0",
      )}
    />
  );
}

/** Menu recolhido: item com contador de alerta ganha um ponto amarelo no canto do ícone. */
function WarnDot() {
  return (
    <span
      aria-hidden
      className="absolute top-1.5 right-2 size-[7px] rounded-full bg-(--c-e0a019) shadow-[0_0_0_2px_var(--sb-bg)]"
    />
  );
}

const ITEM =
  "group relative flex h-[34px] items-center gap-2.5 rounded-[7px] text-[13.5px] whitespace-nowrap transition-colors duration-200";
// recolhido: só o ícone, centralizado em 44px (64px do menu - 2 x 10px de margem)
const itemPad = (collapsed: boolean) => (collapsed ? "px-[14.5px]" : "px-2.5");

function NavLink({
  item,
  active,
  counts,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  counts?: NavCounts;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const badge = item.badge && counts ? counts[item.badge] : 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        ITEM,
        itemPad(collapsed),
        active ? "bg-(--sb-active-bg) font-medium text-(--sb-active-fg)" : "text-(--sb-item) hover:bg-(--sb-hover)",
      )}
    >
      <ActiveBar on={active} />
      <Icon
        className={cn("size-[15px] shrink-0 transition-transform duration-200", EASE, !active && "group-hover:scale-110")}
      />
      {collapsed ? (
        badge > 0 && item.badgeWarn ? <WarnDot /> : null
      ) : (
        <>
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
        </>
      )}
    </Link>
  );
}

/** Menu recolhido: a pasta abre um menu flutuante ao passar o mouse (ou ao clicar). */
function FolderFlyout({
  folder,
  items,
  pathname,
  counts,
}: {
  folder: NavFolder;
  items: NavItem[];
  pathname: string;
  counts?: NavCounts;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inside = items.some((i) => isActive(i.href, pathname));
  const total = folderBadge({ ...folder, children: items }, counts);
  const Icon = folder.icon;

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={folder.label}
          aria-label={folder.label}
          onMouseEnter={show}
          onMouseLeave={hide}
          className={cn(
            ITEM,
            itemPad(true),
            "w-full",
            inside ? "bg-(--sb-active-bg) font-medium text-(--sb-active-fg)" : "text-(--sb-item) hover:bg-(--sb-hover)",
          )}
        >
          <ActiveBar on={inside} />
          <Icon
            className={cn("size-[15px] shrink-0 transition-transform duration-200", EASE, !inside && "group-hover:scale-110")}
          />
          {total.value > 0 && total.warn ? <WarnDot /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={show}
        onMouseLeave={hide}
        className="w-[230px] gap-0.5 rounded-[10px] border border-(--sb-flyout-border) bg-(--sb-bg) p-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.12)] ring-0"
      >
        <p className="px-2.5 pt-1 pb-1.5 text-[10.5px] font-medium tracking-[0.06em] text-(--sb-muted) uppercase">
          {folder.label}
        </p>
        {items.map((item) => {
          const active = isActive(item.href, pathname);
          const badge = item.badge && counts ? counts[item.badge] : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] hover:no-underline",
                active ? "bg-(--sb-active-bg) font-medium text-(--sb-active-fg)" : "text-(--sb-item) hover:bg-(--sb-hover)",
              )}
            >
              <item.icon className="size-[14px] shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {badge > 0 ? <Count value={badge} warn={item.badgeWarn} /> : null}
            </Link>
          );
        })}
      </PopoverContent>
    </Popover>
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
          ITEM,
          "w-full px-2.5 text-left",
          inside && !open
            ? "bg-(--sb-active-bg) font-medium text-(--sb-active-fg)"
            : "text-(--sb-item) hover:bg-(--sb-hover)",
          inside && open && "font-medium",
        )}
      >
        <ActiveBar on={inside && !open} />
        <Icon
          className={cn(
            "size-[15px] shrink-0 transition-[color,transform] duration-200",
            EASE,
            inside ? "text-(--sb-bar)" : "group-hover:scale-110",
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
          className={cn("size-3.5 shrink-0 text-(--sb-muted) transition-transform duration-300", EASE, open && "rotate-90")}
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
                    "group ml-[25px] flex items-center gap-2 rounded-[7px] px-2.5 py-[6px] text-[13px] whitespace-nowrap transition-colors duration-200",
                    // sem negrito no ativo: "Fila de processamento" + contador não cabe em 232px
                    active
                      ? "bg-(--sb-active-bg) text-(--sb-active-fg)"
                      : "text-(--sb-muted) hover:bg-(--sb-hover) hover:text-(--sb-item)",
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
  collapsed = false,
  onNavigate,
}: {
  role: UserRole;
  isOwner?: boolean;
  counts?: NavCounts;
  folderState?: NavFolderState;
  collapsed?: boolean;
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
            {collapsed ? (
              <span aria-hidden className="mx-2 my-1.5 block h-px bg-(--sb-line)" />
            ) : (
              <p className="px-2.5 py-1 text-[10.5px] font-medium tracking-[0.06em] whitespace-nowrap text-(--sb-muted) uppercase">
                {group.label}
              </p>
            )}
            {entries.map(({ entry, items }) =>
              isFolder(entry) ? (
                collapsed ? (
                  <FolderFlyout key={entry.key} folder={entry} items={items} pathname={pathname} counts={counts} />
                ) : (
                  <NavFolderEntry
                    key={entry.key}
                    folder={entry}
                    items={items}
                    pathname={pathname}
                    counts={counts}
                    folderState={folderState}
                    onNavigate={onNavigate}
                  />
                )
              ) : (
                <NavLink
                  key={entry.href}
                  item={entry}
                  active={isActive(entry.href, pathname)}
                  counts={counts}
                  collapsed={collapsed}
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

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 whitespace-nowrap text-(--sb-strong) hover:no-underline">
      <Image src="/brand/logo-mark.png" alt="JR Sistema" width={34} height={34} priority className="size-[34px] shrink-0" />
      {compact ? null : (
        <div className="leading-tight">
          <p className="text-sm font-semibold">
            <span className="text-(--sb-brand)">JR</span> Sistema
          </p>
          <p className="text-[11px] text-(--sb-muted)">Automação SIAT · SEFAZ-PI</p>
        </div>
      )}
    </Link>
  );
}

/** Iniciais do escritório para o quadradinho do rodapé ("Contabilidade Rocha & Lima" -> "CR"). */
export function officeInitials(name: string | null): string {
  const words = (name ?? "")
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w) && !/^(e|de|da|do|das|dos)$/i.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function OfficeFooter({ orgName, isOwner, collapsed }: { orgName: string | null; isOwner: boolean; collapsed: boolean }) {
  const name = orgName ?? "Sem escritório";
  const body = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-(--sb-chip) text-xs font-semibold text-(--sb-strong)">
        {officeInitials(orgName) || "—"}
      </span>
      {collapsed ? null : (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="truncate text-[12.5px] font-medium text-(--sb-strong)" title={orgName ?? undefined}>
              {name}
            </p>
            <p className="text-[11px] text-(--sb-muted)">{isOwner ? "Dono da plataforma" : "Escritório"}</p>
          </div>
          {isOwner ? <ChevronsUpDown className="size-3.5 shrink-0 text-(--sb-muted)" /> : null}
        </>
      )}
    </>
  );
  const cls = "flex h-14 shrink-0 items-center gap-2.5 border-t border-(--sb-line) px-4 whitespace-nowrap";
  // só o dono da plataforma tem outros escritórios para ver
  return isOwner ? (
    <Link
      href="/organizations"
      title={collapsed ? name : undefined}
      className={cn(cls, "hover:bg-(--sb-hover) hover:no-underline")}
    >
      {body}
    </Link>
  ) : (
    <div title={collapsed ? name : undefined} className={cls}>
      {body}
    </div>
  );
}

function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="shrink-0 border-t border-(--sb-line) px-2.5 py-2">
      <button
        type="button"
        onClick={onToggle}
        title={collapsed ? "Expandir menu (Ctrl+B)" : "Recolher menu (Ctrl+B)"}
        aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
        aria-keyshortcuts="Control+B"
        className={cn(
          "flex h-[34px] w-full items-center gap-2.5 rounded-[7px] text-[13px] whitespace-nowrap text-(--sb-muted) transition-colors hover:bg-(--sb-hover) hover:text-(--sb-strong)",
          collapsed ? "px-3.5" : "px-2.5",
        )}
      >
        <Icon className="size-4 shrink-0" />
        {collapsed ? null : (
          <>
            <span className="flex-1 text-left">Recolher menu</span>
            <kbd className="font-mono text-[11px] text-(--sb-muted)">Ctrl B</kbd>
          </>
        )}
      </button>
    </div>
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
  const { collapsed, toggle } = useSidebar();
  return (
    <aside
      data-sidebar
      className={cn(
        "fixed inset-y-0 left-0 z-30 hidden w-(--sb-w) flex-col overflow-hidden border-r border-(--sb-border) bg-(--sb-bg) shadow-sidebar transition-[width] duration-300 lg:flex",
        EASE,
      )}
    >
      <div className="flex h-16 shrink-0 items-center border-b border-(--sb-line) px-[15px]">
        <Brand compact={collapsed} />
      </div>
      <div className="no-scrollbar flex-1 overflow-x-hidden overflow-y-auto py-2">
        <SidebarNav role={role} isOwner={isOwner} counts={counts} folderState={folderState} collapsed={collapsed} />
      </div>
      <CollapseToggle collapsed={collapsed} onToggle={toggle} />
      <OfficeFooter orgName={orgName} isOwner={isOwner} collapsed={collapsed} />
    </aside>
  );
}
