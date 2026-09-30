import {
  Bot,
  Building2,
  Download,
  FileSearch,
  History,
  Laptop,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Users,
  type LucideIcon,
  ScanSearch,
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

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operação",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/automation", label: "Automação SIAT", icon: Bot, permission: "automation:run" },
      { href: "/efd", label: "Consulta EFD", icon: FileSearch },
      { href: "/malhas", label: "Consulta de Malhas", icon: ScanSearch },
      { href: "/queue", label: "Fila de processamento", icon: ListOrdered, badge: "queue", badgeWarn: true },
      { href: "/downloads", label: "Downloads", icon: Download, badge: "downloads" },
      { href: "/history", label: "Histórico", icon: History },
      { href: "/errors", label: "Erros", icon: TriangleAlert },
    ],
  },
  {
    label: "Cadastros",
    items: [
      { href: "/clients", label: "Clientes", icon: Building2, badge: "clients" },
      { href: "/certificates", label: "Certificados", icon: ShieldCheck },
      { href: "/organizations", label: "Escritórios", icon: Landmark, ownerOnly: true },
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

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Grupo e item do menu para a rota atual (breadcrumb do cabeçalho). */
export function navLocation(pathname: string): { group: string; label: string } | null {
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return { group: g.label, label: item.label };
    }
  }
  return null;
}
