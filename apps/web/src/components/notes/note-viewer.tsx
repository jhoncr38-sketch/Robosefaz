"use client";

import { Download, FolderDown, Loader2, Printer, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { requestNoteXml } from "@/app/actions/notes";
import { DanfeView } from "@/components/notes/danfe-view";
import { parseDanfe } from "@/lib/danfe";
import { createClient } from "@/lib/supabase/client";
import type { NoteRow } from "@/lib/types";

/** Quanto tempo esperar o robô antes de oferecer o ZIP. */
const WAIT_LIMIT_MS = 90_000;

/**
 * "Ver a nota": se o XML ainda não veio, pede ao robô e acompanha a chegada (tempo real, com uma
 * conferência a cada 4 s por garantia). Depois monta a DANFE na tela.
 */
export function NoteViewer({ note, driveUrl }: { note: NoteRow; driveUrl: string | null }) {
  const [xml, setXml] = useState<string | null>(note.xml ?? null);
  const [error, setError] = useState<string | null>(note.xml_error ?? null);
  const [attempt, setAttempt] = useState(0);
  // segundos esperando o robô (atualizado pela conferência periódica)
  const [waited, setWaited] = useState(0);
  const tooLong = waited * 1000 > WAIT_LIMIT_MS;

  useEffect(() => {
    if (xml || error) return;
    let alive = true;
    const supabase = createClient();
    const begin = Date.now();
    void requestNoteXml(note.id).then((res) => {
      if (alive && !res.ok) setError(res.error);
    });
    const apply = (row: { xml?: string | null; xml_error?: string | null }) => {
      if (!alive) return;
      if (row.xml) setXml(row.xml);
      else if (row.xml_error) setError(row.xml_error);
    };
    const channel = supabase
      .channel(`notes:${note.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "notes", filter: `id=eq.${note.id}` }, (payload) =>
        apply(payload.new as { xml?: string | null; xml_error?: string | null }),
      )
      .subscribe();
    const poll = setInterval(async () => {
      setWaited(Math.round((Date.now() - begin) / 1000));
      const { data } = await supabase.from("notes").select("xml, xml_error").eq("id", note.id).maybeSingle();
      if (data) apply(data);
    }, 4000);
    return () => {
      alive = false;
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [note.id, xml, error, attempt]);

  const data = useMemo(() => (xml ? parseDanfe(xml) : null), [xml]);

  function downloadXml() {
    if (!xml) return;
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${note.chave}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const retry = () => {
    setError(null);
    setWaited(0);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <button
          type="button"
          onClick={downloadXml}
          disabled={!xml}
          className="flex h-8 items-center gap-1.5 rounded-[7px] border border-input bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-(--c-fafaf8) disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="size-3.5" /> Baixar XML desta nota
        </button>
        {driveUrl ? (
          <a
            href={driveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-[7px] border border-input bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-(--c-fafaf8) hover:no-underline"
          >
            <FolderDown className="size-3.5" /> ZIP do mês
          </a>
        ) : null}
        <button
          type="button"
          onClick={() => window.print()}
          disabled={!data}
          className="flex h-8 items-center gap-1.5 rounded-[7px] bg-primary px-3 text-[12.5px] font-medium text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
        >
          <Printer className="size-3.5" /> Imprimir
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-(--c-fdf4e3) px-3 py-2 text-xs text-(--c-9a6205) print:hidden">
        <TriangleAlert className="size-3.5 shrink-0" />
        Visualização para conferência, montada a partir do XML. O documento fiscal é o XML; a DANFE oficial é a emitida pelo
        contribuinte.
      </div>

      {data ? (
        <DanfeView data={data} />
      ) : xml && !data ? (
        <div className="rounded-lg border border-(--c-f0c9c9) bg-(--c-fdecec) px-4 py-3 text-[13px] text-(--c-b42323)">
          O XML chegou, mas não está no formato de uma NF-e/NFC-e. Baixe o XML para conferir.
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-(--c-f0c9c9) bg-(--c-fdecec) px-4 py-3 text-[13px] text-(--c-b42323)">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={retry} className="flex items-center gap-1.5 text-xs font-medium underline">
            <RefreshCw className="size-3.5" /> Tentar de novo
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-(--c-d9d9d4) px-6 py-10 text-center">
          <Loader2 className="size-5 animate-spin text-primary" />
          <p className="text-[13.5px] font-medium">O robô está abrindo o ZIP e separando esta nota…</p>
          <p className="text-xs text-(--c-6b6c66)">
            Costuma levar alguns segundos. Precisa de um computador com o robô ligado e a pasta das notas.
          </p>
          {tooLong ? (
            <div className="mt-2 flex flex-col items-center gap-2 text-xs text-(--c-9a6205)">
              <span>
                Está demorando mais que o normal ({waited} s). O robô pode estar desligado.
              </span>
              <span className="text-(--c-6b6c66)">
                Enquanto isso, você pode baixar o ZIP do mês pelo botão acima; a nota está no arquivo{" "}
                <span className="font-mono">{note.xml_name}</span>.
              </span>
              <button type="button" onClick={retry} className="flex items-center gap-1.5 font-medium text-primary underline">
                <RefreshCw className="size-3.5" /> Pedir de novo
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
