import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { can, type Permission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

export interface Session {
  userId: string;
  email: string;
  profile: Profile;
}

/** Sessão + profile do usuário atual (memoizado por request). */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
  if (!profile) return null;
  return { userId: user.id, email: user.email ?? profile.email, profile: profile as Profile };
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.profile.active) redirect("/login?error=inactive");
  return session;
}

export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!can(session.profile.role, permission)) redirect("/dashboard?error=forbidden");
  return session;
}

/** Para Server Actions: retorna a sessão ou uma mensagem de erro (sem redirect). */
export async function authorize(permission?: Permission): Promise<{ session: Session } | { error: string }> {
  const session = await getSession();
  if (!session || !session.profile.active) return { error: "Sessão expirada. Faça login novamente." };
  if (permission && !can(session.profile.role, permission)) {
    return { error: "Você não tem permissão para esta ação." };
  }
  return { session };
}

export async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}
