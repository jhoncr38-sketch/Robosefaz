"use server";

import { authorize } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/types";

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
