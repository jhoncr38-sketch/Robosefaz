import {
  Bot,
  Building2,
  Download,
  FileSearch,
  FolderOpen,
  History,
  Laptop,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  Play,
  ScanSearch,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { Permission } from "@/lib/permissions";

/** Contadores exibidos ao lado dos itens do menu. */
export interface NavCounts {
  queue: number;
  downloads: number;
  clients: number;
}

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  /** só o dono da plataforma vê */
  ownerOnly?: boolean;
  badge?: keyof NavCounts;
  /** contador em amarelo (pede atenção) */
  badgeWarn?: boolean;
}

/** Item que abre e fecha um submenu (ex.: SIAT). */
export interface NavFolder {
  key: string;
  label: string;
  icon: LucideIcon;
  children: NavItem[];
}

export type NavEntry = NavItem | NavFolder;

export interface NavGroup {
  label: string;
  items: NavEntry[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operação",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      {
        key: "siat",
        label: "SIAT",
        icon: Bot,
        children: [
          { href: "/automation", label: "Executar automações", icon: Play, permission: "automation:run" },
          { href: "/malhas", label: "Consulta de Malhas", icon: ScanSearch },
          { href: "/efd", label: "Consulta EFD", icon: FileSearch },
          { href: "/queue", label: "Fila de processamento", icon: ListOrdered, badge: "queue", badgeWarn: true },
        ],
      },
      {
        key: "resultados",
        label: "Resultados",
        icon: FolderOpen,
        children: [
          { href: "/downloads", label: "Downloads", icon: Download, badge: "downloads" },
          { href: "/history", label: "Histórico", icon: History },
          { href: "/errors", label: "Erros", icon: TriangleAlert },
        ],
      },
    ],
  },
  {
    label: "Cadastros",
    items: [
      {
        key: "empresas",
        label: "Empresas",
        icon: Building2,
        children: [
          { href: "/clients", label: "Clientes", icon: Building2, badge: "clients" },
          { href: "/certificates", label: "Certificados", icon: ShieldCheck },
          { href: "/organizations", label: "Escritórios", icon: Landmark, ownerOnly: true },
        ],
      },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/users", label: "Usuários", icon: Users, permission: "users:manage" },
      { href: "/devices", label: "Computadores", icon: Laptop },
      { href: "/settings", label: "Configurações", icon: Settings },
    ],
  },
];

export function isFolder(entry: NavEntry): entry is NavFolder {
  return "children" in entry;
}

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items.flatMap((e) => (isFolder(e) ? e.children : [e])));

export function isActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Soma dos contadores do submenu (aparece no item pai quando ele está fechado). */
export function folderBadge(folder: NavFolder, counts?: NavCounts): { value: number; warn: boolean } {
  let value = 0;
  let warn = false;
  for (const item of folder.children) {
    const n = item.badge && counts ? counts[item.badge] : 0;
    value += n;
    if (n > 0 && item.badgeWarn) warn = true;
  }
  return { value, warn };
}

/**
 * Escolhas do usuário por submenu (true = aberto, false = fechado), guardadas no cookie
 * "siat:1,resultados:0" e lidas no servidor para o menu não "piscar" ao carregar.
 */
export type NavFolderState = Record<string, boolean>;

export const NAV_STATE_COOKIE = "jr-nav";

export function parseFolderState(value: string | undefined | null): NavFolderState {
  const state: NavFolderState = {};
  for (const part of (value ?? "").split(",")) {
    const m = /^\s*([a-z0-9-]+):([01])\s*$/.exec(part);
    if (m) state[m[1]] = m[2] === "1";
  }
  return state;
}

export function serializeFolderState(state: NavFolderState): string {
  return Object.entries(state)
    .map(([key, open]) => `${key}:${open ? 1 : 0}`)
    .join(",");
}

/** Grupo e item do menu para a rota atual (breadcrumb do cabeçalho). */
export function navLocation(pathname: string): { group: string; label: string } | null {
  for (const g of NAV_GROUPS) {
    for (const entry of g.items) {
      if (isFolder(entry)) {
        const child = entry.children.find((c) => isActive(c.href, pathname));
        if (child) return { group: entry.label, label: child.label };
      } else if (isActive(entry.href, pathname)) {
        return { group: g.label, label: entry.label };
      }
    }
  }
  return null;
}
