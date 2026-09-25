import type { UserRole } from "@/lib/types";

export type Permission =
  | "clients:write"
  | "certificates:write"
  | "automation:run"
  | "automation:force"
  | "automation:retry"
  | "automation:cancel"
  | "settings:write"
  | "users:manage"
  | "audit:read";

const MATRIX: Record<UserRole, Permission[]> = {
  admin: [
    "clients:write",
    "certificates:write",
    "automation:run",
    "automation:force",
    "automation:retry",
    "automation:cancel",
    "settings:write",
    "users:manage",
    "audit:read",
  ],
  operator: ["automation:run", "automation:cancel"],
  viewer: [],
};

export function can(role: UserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return MATRIX[role].includes(permission);
}

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Administrador",
  operator: "Operador",
  viewer: "Visualizador",
};
