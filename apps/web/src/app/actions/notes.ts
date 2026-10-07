"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { authorize } from "@/lib/auth";
import { keyDigits } from "@/lib/nfe-key";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

/**
 * "Buscar no SIAT": cria o trabalho do robô que entra no SIAT com o certificado da empresa
 * escolhida e exporta só esta nota pela chave. Volta para a tela Notas, que acompanha o robô.
 */
export async function searchNoteInSiat(formData: FormData): Promise<void> {
  const chave = keyDigits(String(formData.get("chave") ?? ""));
  const clientId = String(formData.get("client_id") ?? "");
  const back = `/notes?q=${chave}`;
  const auth = await authorize("automation:run");
  if ("error" in auth) redirect(`${back}&erro=${encodeURIComponent(auth.error)}`);
  if (!clientId) redirect(`${back}&erro=${encodeURIComponent("Escolha a empresa com cujo certificado o robô deve entrar.")}`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_note_from_siat", { p_client_id: clientId, p_chave: chave });
  if (error) redirect(`${back}&erro=${encodeURIComponent(error.message.replace(/^[A-Z_]+: /, ""))}`);
  revalidatePath("/notes");
  revalidatePath("/queue");
  redirect(back);
}

/**
 * "Ver a nota": pede ao robô o XML desta nota. O robô que tem a pasta das notas extrai só esse
 * XML do ZIP e grava em notes.xml; a tela acompanha pelo tempo real.
 */
export async function requestNoteXml(noteId: string): Promise<ActionResult<boolean>> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_note_xml", { p_note_id: noteId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: Boolean(data) };
}
