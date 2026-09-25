"use server";

import { revalidatePath } from "next/cache";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult, Certificate } from "@/lib/types";
import { certificateSchema, type CertificateInput } from "@/lib/validation";
import { WorkerApiError, workerJson } from "@/lib/worker-api";

export interface PfxInfo {
  subject_name: string;
  common_name: string;
  issuer: string;
  issuer_common_name: string;
  serial_number: string;
  thumbprint: string;
  valid_from: string;
  valid_until: string;
  cnpj: string | null;
}

export interface ChromePolicyPreview {
  registry_key: string;
  value: string;
  reg_file: string;
  write_enabled: boolean;
  mode: string;
}

function apiError(e: unknown): string {
  return e instanceof WorkerApiError ? e.message : "Falha ao comunicar com a API do worker.";
}

function revalidate(clientId?: string) {
  revalidatePath("/certificates");
  revalidatePath("/dashboard");
  revalidatePath("/clients");
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

export async function saveCertificate(id: string | null, input: CertificateInput): Promise<ActionResult<Certificate>> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };

  const parsed = certificateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Verifique os campos do certificado.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const supabase = await createClient();
  const values = {
    ...parsed.data,
    valid_until: new Date(parsed.data.valid_until).toISOString(),
    valid_from: parsed.data.valid_from ? new Date(parsed.data.valid_from).toISOString() : null,
    browser_profile: parsed.data.client_id, // perfil exclusivo por cliente
  };

  if (id) {
    const { data, error } = await supabase.from("certificates").update(values).eq("id", id).select("*").single();
    if (error) return { ok: false, error: error.message };
    revalidate(values.client_id);
    return { ok: true, data: data as Certificate, message: "Certificado atualizado." };
  }

  // Um certificado ativo por cliente: o anterior é desativado (mantém histórico).
  const { error: deactivateError } = await supabase
    .from("certificates")
    .update({ active: false })
    .eq("client_id", values.client_id)
    .eq("active", true);
  if (deactivateError) return { ok: false, error: deactivateError.message };

  const { data, error } = await supabase
    .from("certificates")
    .insert({ ...values, active: true })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidate(values.client_id);
  return { ok: true, data: data as Certificate, message: "Certificado associado ao cliente." };
}

export async function deactivateCertificate(id: string): Promise<ActionResult> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("certificates")
    .update({ active: false })
    .eq("id", id)
    .select("client_id")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidate(data.client_id);
  return { ok: true, message: "Certificado desativado." };
}

/** Lê metadados do PFX na API do worker. Arquivo e senha não são armazenados. */
export async function inspectPfx(formData: FormData): Promise<ActionResult<PfxInfo>> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Selecione o arquivo .pfx/.p12." };
  const body = new FormData();
  body.set("file", file);
  body.set("password", String(formData.get("password") ?? ""));
  try {
    const info = await workerJson<PfxInfo>("/certificates/inspect", { method: "POST", body });
    return { ok: true, data: info };
  } catch (e) {
    return { ok: false, error: apiError(e) };
  }
}

/** Salva a senha no cofre do worker (Windows Credential Manager / arquivo cifrado). */
export async function saveCertificateSecret(id: string, secret: string): Promise<ActionResult> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!secret) return { ok: false, error: "Informe a senha." };
  try {
    await workerJson(`/certificates/${id}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
  } catch (e) {
    return { ok: false, error: apiError(e) };
  }
  revalidate();
  return { ok: true, message: "Senha armazenada com segurança no cofre do worker." };
}

export async function deleteCertificateSecret(id: string): Promise<ActionResult> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    await workerJson(`/certificates/${id}/secret`, { method: "DELETE" });
  } catch (e) {
    return { ok: false, error: apiError(e) };
  }
  revalidate();
  return { ok: true, message: "Senha removida do cofre." };
}

export async function getChromePolicy(id: string): Promise<ActionResult<ChromePolicyPreview>> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    return { ok: true, data: await workerJson<ChromePolicyPreview>(`/certificates/${id}/chrome-policy`) };
  } catch (e) {
    return { ok: false, error: apiError(e) };
  }
}

export async function openBrowserProfile(clientId: string): Promise<ActionResult<{ status: string; message: string }>> {
  const auth = await authorize("certificates:write");
  if ("error" in auth) return { ok: false, error: auth.error };
  try {
    const data = await workerJson<{ status: string; message: string }>(
      `/clients/${clientId}/browser-profile/open`,
      { method: "POST" },
    );
    return { ok: true, data, message: "Perfil do navegador aberto na máquina do worker." };
  } catch (e) {
    return { ok: false, error: apiError(e) };
  }
}
