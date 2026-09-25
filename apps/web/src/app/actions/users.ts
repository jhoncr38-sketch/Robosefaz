"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, UserRole } from "@/lib/types";
import { userCreateSchema } from "@/lib/validation";

export async function createUser(input: z.input<typeof userCreateSchema>): Promise<ActionResult> {
  const auth = await authorize("users:manage");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = userCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Verifique os campos.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { name, email, role, password } = parsed.data;

  let admin;
  try {
    admin = createAdminClient();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Papel em app_metadata: somente a service role consegue definir/alterar.
  const { error } = password
    ? await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
        app_metadata: { role },
      })
    : await admin.auth.admin.inviteUserByEmail(email, { data: { name } }).then(async (res) => {
        if (res.error || !res.data.user) return res;
        await admin.auth.admin.updateUserById(res.data.user.id, { app_metadata: { role } });
        const supabase = await createClient();
        await supabase.from("profiles").update({ role, name }).eq("user_id", res.data.user.id);
        return res;
      });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/users");
  return { ok: true, message: password ? "Usuário criado." : "Convite enviado por e-mail." };
}

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.enum(["admin", "operator", "viewer"]).optional(),
  active: z.boolean().optional(),
});

export async function updateUser(
  profileId: string,
  input: { name?: string; role?: UserRole; active?: boolean },
): Promise<ActionResult> {
  const auth = await authorize("users:manage");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Dados inválidos." };

  if (profileId === auth.session.profile.id && (parsed.data.role && parsed.data.role !== "admin" || parsed.data.active === false)) {
    return { ok: false, error: "Você não pode remover o próprio acesso de administrador." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update(parsed.data)
    .eq("id", profileId)
    .select("user_id")
    .single();
  if (error) return { ok: false, error: error.message };

  if (parsed.data.role) {
    try {
      await createAdminClient().auth.admin.updateUserById(data.user_id, { app_metadata: { role: parsed.data.role } });
    } catch {
      // sem service role no painel: o papel efetivo continua sendo o do profile
    }
  }
  revalidatePath("/users");
  return { ok: true, message: "Usuário atualizado." };
}
