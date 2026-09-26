import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

// Ativação de um computador com o robô (chamado pelo instalador, sem login).
// Troca o código de uso único (gerado em Computadores) por um login técnico
// do Supabase vinculado ao escritório. A senha é devolvida UMA vez e o robô a
// guarda no cofre do Windows; ela não fica em lugar nenhum do painel.
const bodySchema = z.object({
  code: z.string().trim().min(8).max(20),
  name: z.string().trim().min(1).max(80),
});

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Informe o código de ativação." }, { status: 400 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Ativação indisponível no momento." }, { status: 503 });
  }

  const { data: redeemed, error } = await admin.rpc("redeem_device_activation_code", {
    p_code: parsed.data.code,
    p_name: parsed.data.name,
  });
  if (error || !redeemed) {
    const expired = /INVALID_CODE/.test(error?.message ?? "");
    const suspended = /ORG_SUSPENDED/.test(error?.message ?? "");
    return NextResponse.json(
      {
        error: suspended
          ? "O escritório está suspenso."
          : expired
            ? "Código inválido, expirado ou já usado. Gere um novo em Computadores no painel."
            : "Não foi possível ativar o computador.",
      },
      { status: expired || suspended ? 400 : 500 },
    );
  }

  const { device_id: deviceId, org_id: orgId, org_name: orgName } = redeemed as {
    device_id: string;
    org_id: string;
    org_name: string;
  };
  const email = `robo-${deviceId}@robos.jrsistema.com`;
  const password = randomBytes(32).toString("base64url");

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { kind: "device", org_id: orgId, device_id: deviceId },
  });
  if (created.error || !created.data.user) {
    await admin.rpc("revoke_device", { p_device_id: deviceId });
    return NextResponse.json({ error: "Não foi possível criar o acesso do computador." }, { status: 500 });
  }

  const { error: linkError } = await admin
    .from("devices")
    .update({ auth_user_id: created.data.user.id })
    .eq("id", deviceId);
  if (linkError) {
    await admin.auth.admin.deleteUser(created.data.user.id);
    await admin.rpc("revoke_device", { p_device_id: deviceId });
    return NextResponse.json({ error: "Não foi possível vincular o computador." }, { status: 500 });
  }

  return NextResponse.json(
    {
      device_id: deviceId,
      org_name: orgName,
      email,
      password,
      supabase_url: publicEnv.supabaseUrl,
      publishable_key: publicEnv.supabaseAnonKey,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
