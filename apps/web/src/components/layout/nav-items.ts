import {
  AlertTriangle,
  Bot,
  Building2,
  Download,
  History,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { Permission } from "@/lib/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  /** só o dono da plataforma vê */
  ownerOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clientes", icon: Building2 },
  { href: "/certificates", label: "Certificados", icon: ShieldCheck },
  { href: "/automation", label: "Automação SIAT", icon: Bot },
  { href: "/queue", label: "Fila de processamento", icon: ListOrdered },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/history", label: "Histórico", icon: History },
  { href: "/errors", label: "Erros", icon: AlertTriangle },
  { href: "/users", label: "Usuários", icon: Users, permission: "users:manage" },
  { href: "/settings", label: "Configurações", icon: Settings },
  { href: "/organizations", label: "Escritórios", icon: Landmark, ownerOnly: true },
];
