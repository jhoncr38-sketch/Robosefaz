"use client";

// Aviso flutuante (canto inferior direito, em todas as telas): trabalho parado esperando um
// computador desligado e o que fazer. O "x" recolhe numa pílula; some sozinho quando resolve e
// volta a abrir se outro trabalho parar.
import { ChevronRight, PowerOff, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useNow } from "@/hooks/use-now";
import { formatCompetence } from "@/lib/competence";
import { type Computer, computersFrom, groupText, groupWaits, offlineSince, type PcWaitGroup, pcWait } from "@/lib/pc-wait";
import { createClient } from "@/lib/supabase/client";
import type { AutomationJob } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 30_000;
const SHOWN_JOBS = 3;
const STORAGE_KEY = "jr-pcwait-recolhido";

const SHADOW = "shadow-[0_12px_32px_-14px_rgba(0,0,0,.28),0_2px_6px_-2px_rgba(0,0,0,.08)]";

function clientName(job: AutomationJob): string {
  return job.clients?.trade_name || job.clients?.legal_name || "Cliente";
}

/** "aguardando o PC Alex", "sem computador com o certificado", "nenhum robô ligado" */
function shortWhat(g: PcWaitGroup<AutomationJob>): string {
  if (g.kind === "handover") return `aguardando o PC ${g.waitingFor.map((c) => c.hostname).join(" ou ")}`;
  return g.kind === "no_other_pc" ? "sem computador com o certificado" : "nenhum robô ligado";
}

function plural(n: number): string {
  return n === 1 ? "1 trabalho parado" : `${n} trabalhos parados`;
}

/** Só a aparência (a prévia usa direto, com dados fixos). */
export function PcWaitPopupView({
  jobs,
  computers,
  now,
  minimized,
  onMinimize,
  onOpen,
  className,
}: {
  jobs: AutomationJob[];
  computers: Computer[];
  now: Date;
  minimized: boolean;
  onMinimize?: () => void;
  onOpen?: () => void;
  /** a prévia tira o "fixed" para mostrar dentro da página */
  className?: string;
}) {
  const items = jobs.flatMap((job) => {
    const wait = pcWait(job, computers);
    return wait ? [{ job, wait }] : [];
  });
  if (items.length === 0) return null;
  const groups = groupWaits(items);

  if (minimized) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "pcwait-in fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-xs font-medium text-foreground",
          SHADOW,
          "hover:bg-(--c-fafaf8)",
          className,
        )}
      >
        <span className="size-2 rounded-full bg-(--c-e0a019)" />
        {plural(items.length)}
      </button>
    );
  }

  const [first, ...others] = groups;
  const text = groupText(first, now, first.jobs.length === 1 ? clientName(first.jobs[0]) : undefined);
  const shown = first.jobs.slice(0, SHOWN_JOBS);
  return (
    <aside
      role="status"
      aria-live="polite"
      className={cn(
        "pcwait-in fixed right-4 bottom-4 z-40 w-[372px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card",
        SHADOW,
        className,
      )}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-(--c-fdf4e3) text-(--c-9a6205)">
          <PowerOff className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-foreground">{plural(items.length)}</p>
          <p className="text-xs text-(--c-7a7b75)">
            {text.title} · {text.status}
          </p>
        </div>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Recolher aviso"
          className="-mt-0.5 -mr-1.5 rounded-md p-1 text-(--c-9a9b94) hover:bg-(--c-f3f3f0) hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="px-4 pt-2.5 pb-3.5 text-[12.5px] text-(--c-4a4b46)">
        <p className="truncate">
          {shown.map((job, i) => (
            <span key={job.id}>
              {i > 0 ? ", " : null}
              {clientName(job)} <span className="text-(--c-9a9b94)">({formatCompetence(job.competence)})</span>
            </span>
          ))}
          {first.jobs.length > shown.length ? ` e mais ${first.jobs.length - shown.length}` : null}
        </p>
        <p className="mt-3 text-[10.5px] font-medium tracking-[0.06em] text-(--c-9a9b94) uppercase">O que fazer</p>
        <ol className="mt-1.5 space-y-1.5">
          {text.steps.map((step, i) => (
            <li key={step} className="flex gap-2">
              <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-(--c-f3f3f0) text-[10.5px] font-medium text-(--c-6b6b66)">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        {others.length > 0 ? (
          <p className="mt-2.5 text-xs text-(--c-7a7b75)">
            Também:{" "}
            {others.map((g) => `${g.jobs.length} ${shortWhat(g)}`).join("; ")}
            .
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3 border-t bg-(--c-fafaf8) px-4 py-2.5 text-[11.5px] text-(--c-7a7b75)">
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5">
          {computers.map((c) => (
            <span key={c.hostname} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className={cn("size-1.5 rounded-full", c.online ? "bg-(--c-1c7a47)" : "bg-(--c-a3a39e)")} />
              {c.hostname} {c.online ? "ligado" : `desligado ${offlineSince(c, now)}`}
            </span>
          ))}
        </div>
        <Link href="/queue" className="inline-flex shrink-0 items-center gap-0.5 font-medium text-primary hover:no-underline">
          Ver na fila <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </aside>
  );
}

function readMinimized(): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeMinimized(key: string | null): void {
  try {
    if (key) window.sessionStorage.setItem(STORAGE_KEY, key);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // navegador sem armazenamento: o aviso só não lembra que foi recolhido
  }
}

/** Versão do site: busca os trabalhos parados e o sinal dos computadores a cada 30 s. */
export function PcWaitPopup() {
  const [data, setData] = useState<{ jobs: AutomationJob[]; computers: Computer[] } | null>(null);
  const [minimizedKey, setMinimizedKey] = useState<string | null>(readMinimized);
  const tick = useNow(POLL_MS);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    async function load() {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [jobs, heartbeats] = await Promise.all([
        supabase
          .from("automation_jobs")
          .select("id, client_id, competence, status, locked_by, skip_hosts, clients(client_code, legal_name, trade_name, cnpj)")
          .in("status", ["queued", "waiting_sefaz"])
          .is("locked_by", null)
          .limit(500),
        supabase.from("worker_heartbeats").select("worker_id, hostname, status, last_seen_at").gte("last_seen_at", since),
      ]);
      if (!alive || jobs.error || heartbeats.error) return;
      setData({
        jobs: (jobs.data ?? []) as unknown as AutomationJob[],
        computers: computersFrom(heartbeats.data ?? [], Date.now()),
      });
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!data || tick === null) return null;
  // recolhido vale para o mesmo conjunto de trabalhos; se outro parar, abre de novo
  const key = data.jobs
    .filter((j) => pcWait(j, data.computers))
    .map((j) => j.id)
    .sort()
    .join(",");
  return (
    <PcWaitPopupView
      jobs={data.jobs}
      computers={data.computers}
      now={new Date(tick)}
      minimized={minimizedKey === key}
      onMinimize={() => {
        setMinimizedKey(key);
        writeMinimized(key);
      }}
      onOpen={() => {
        setMinimizedKey(null);
        writeMinimized(null);
      }}
    />
  );
}
