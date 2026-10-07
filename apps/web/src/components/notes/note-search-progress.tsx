"use client";

import { Bot, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { JOB_STATUS_LABEL } from "@/lib/status";
import { createClient } from "@/lib/supabase/client";
import type { JobStatus } from "@/lib/types";

export interface NoteSearchJob {
  id: string;
  status: JobStatus;
  last_message: string | null;
  error_message: string | null;
  created_at: string;
  clientName: string;
}

const FINAL: JobStatus[] = ["completed", "failed", "cancelled"];

/**
 * "Buscar no SIAT" em andamento: mostra o passo do robô (tempo real, com conferência a cada 4 s)
 * e, assim que a nota entra no índice ou o trabalho termina, recarrega a tela (que passa a
 * mostrar a nota, ou o resultado da busca).
 */
export function NoteSearchProgress({ job, chave }: { job: NoteSearchJob; chave: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<JobStatus>(job.status);
  const [message, setMessage] = useState<string | null>(job.last_message);
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    const begin = new Date(job.created_at).getTime();
    const apply = (row: { status?: JobStatus; last_message?: string | null }) => {
      if (!alive) return;
      if (row.status) setStatus(row.status);
      if (row.last_message !== undefined) setMessage(row.last_message);
      if (row.status && FINAL.includes(row.status)) router.refresh();
    };
    const channel = supabase
      .channel(`note-search:${job.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "automation_jobs", filter: `id=eq.${job.id}` },
        (payload) => apply(payload.new as { status?: JobStatus; last_message?: string | null }),
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notes", filter: `chave=eq.${chave}` }, () =>
        router.refresh(),
      )
      .subscribe();
    const poll = setInterval(async () => {
      setWaited(Math.max(0, Math.round((Date.now() - begin) / 1000)));
      const [{ data: j }, { count }] = await Promise.all([
        supabase.from("automation_jobs").select("status, last_message").eq("id", job.id).maybeSingle(),
        supabase.from("notes").select("id", { count: "exact", head: true }).eq("chave", chave),
      ]);
      if (j) apply(j);
      if ((count ?? 0) > 0) router.refresh();
    }, 4000);
    return () => {
      alive = false;
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [job.id, job.created_at, chave, router]);

  const minutes = Math.floor(waited / 60);
  const elapsed = minutes > 0 ? `${minutes} min ${String(waited % 60).padStart(2, "0")} s` : `${waited} s`;

  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-(--c-d9d9d4) px-6 py-8 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-(--c-e6f4ec) text-primary">
        <Bot className="size-5" />
      </span>
      <p className="text-[13.5px] font-medium">
        O robô está buscando esta nota no SIAT com o certificado de <b>{job.clientName}</b>
      </p>
      <p className="flex items-center gap-1.5 text-xs text-(--c-6b6c66)">
        <Loader2 className="size-3.5 animate-spin text-primary" />
        {JOB_STATUS_LABEL[status] ?? status}
        {message ? <span> · {message}</span> : null}
        {waited > 0 ? <span> · {elapsed}</span> : null}
      </p>
      <p className="max-w-md text-xs text-(--c-6b6c66)">
        Entrar no SIAT e exportar a nota pela chave costuma levar cerca de 1 minuto. Pode sair desta tela: ao terminar,
        chega um aviso no sino e a nota fica disponível aqui.
      </p>
      <Link href={`/history/${job.id}`} className="text-xs font-medium text-primary">
        Acompanhar os passos do robô
      </Link>
    </div>
  );
}
