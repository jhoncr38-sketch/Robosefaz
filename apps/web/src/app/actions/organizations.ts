"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { INVITE_PATH } from "@/lib/auth-link";
import { siteUrl } from "@/lib/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, OrganizationStatus } from "@/lib/types";

async function ownerOnly(): Promise<{ error: string } | { ok: true }> {
  const auth = await authorize();
  if ("error" in auth) return { error: auth.error };
  if (!auth.session.profile.is_platform_owner) return { error: "Somente o dono da plataforma gerencia escritórios." };
  return { ok: true };
}

const createSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome do escritório.").max(120),
  maxClients: z.number().int().min(1).max(100_000).nullable(),
  adminName: z.string().trim().min(2, "Informe o nome do administrador.").max(120),
  adminEmail: z.string().trim().toLowerCase().email("E-mail inválido."),
  adminPassword: z.string().min(8, "A senha precisa de ao menos 8 caracteres.").max(72).optional().or(z.literal("")),
});

/** Cria o escritório e o administrador dele (convite por e-mail ou senha inicial). */
export async function createOrganization(input: z.input<typeof createSchema>): Promise<ActionResult> {
  const guard = await ownerOnly();
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Verifique os campos.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { name, maxClients, adminName, adminEmail, adminPassword } = parsed.data;

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return { ok: false, error: `Convite indisponível: ${(e as Error).message}` };
  }

  const supabase = await createClient();
  const { data: org, error } = await supabase
    .from("organizations")
    .insert({ name, max_clients: maxClients })
    .select("id")
    .single();
  if (error || !org) return { ok: false, error: error?.message ?? "Não foi possível criar o escritório." };

  const appMetadata = { role: "admin", org_id: org.id };
  const res = adminPassword
    ? await admin.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: { name: adminName },
        app_metadata: appMetadata,
      })
    : await admin.auth.admin.inviteUserByEmail(adminEmail, { data: { name: adminName }, redirectTo: await siteUrl(INVITE_PATH) }).then(async (r) => {
        if (r.error || !r.data.user) return r;
        await admin.auth.admin.updateUserById(r.data.user.id, { app_metadata: appMetadata });
        await admin.from("profiles").update({ role: "admin", name: adminName, org_id: org.id }).eq("user_id", r.data.user.id);
        return r;
      });
  if (res.error) {
    // sem administrador o escritório ficaria órfão: desfaz
    await admin.from("organizations").delete().eq("id", org.id);
    return { ok: false, error: `Escritório não criado: ${res.error.message}` };
  }

  revalidatePath("/organizations");
  return {
    ok: true,
    message: adminPassword
      ? `Escritório criado. O administrador já pode entrar com ${adminEmail}.`
      : `Escritório criado. Convite enviado para ${adminEmail}.`,
  };
}

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  maxClients: z.number().int().min(1).max(100_000).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function updateOrganization(
  id: string,
  input: { name?: string; status?: OrganizationStatus; maxClients?: number | null; notes?: string | null },
): Promise<ActionResult> {
  const guard = await ownerOnly();
  if ("error" in guard) return { ok: false, error: guard.error };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Dados inválidos." };

  const auth = await authorize();
  if (!("error" in auth) && parsed.data.status === "suspended" && auth.session.profile.org_id === id) {
    return { ok: false, error: "Você não pode suspender o seu próprio escritório." };
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.maxClients !== undefined) patch.max_clients = parsed.data.maxClients;
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;

  const supabase = await createClient();
  const { error } = await supabase.from("organizations").update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/organizations");
  return {
    ok: true,
    message:
      parsed.data.status === "suspended"
        ? "Escritório suspenso: os usuários dele perdem o acesso."
        : parsed.data.status === "active"
          ? "Escritório reativado."
          : "Escritório atualizado.",
  };
}
