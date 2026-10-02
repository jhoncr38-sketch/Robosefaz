"use client";

// Na fila: "Aguardando o PC Alex" embaixo do status do trabalho parado, com o que fazer no mouse.
// (O aviso geral é o cartão flutuante: components/layout/pc-wait-popup.tsx.)
import { PowerOff } from "lucide-react";
import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { type Computer, computersFrom, groupText, groupWaits, type PcWait } from "@/lib/pc-wait";
import { createClient } from "@/lib/supabase/client";
import type { AutomationJob } from "@/lib/types";

const POLL_MS = 30_000;

/** Sinal dos computadores, atualizado a cada 30 s: o aviso some sozinho quando o PC volta. */
export function useComputers(initial: Computer[], live = true): Computer[] {
  const [computers, setComputers] = useState(initial);
  useEffect(() => {
    if (!live) return;
    const supabase = createClient();
    let alive = true;
    async function load() {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from("worker_heartbeats")
        .select("worker_id, hostname, status, last_seen_at")
        .gte("last_seen_at", since);
      if (alive && !error && data) setComputers(computersFrom(data, Date.now()));
    }
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [live]);
  return computers;
}

/** Hora para "há 29 min": no primeiro desenho, a do servidor (igual no navegador, sem piscar). */
export function useClock(serverNow: string): Date {
  const tick = useNow(POLL_MS);
  return new Date(tick ?? Date.parse(serverNow));
}

function clientName(job: AutomationJob): string {
  return job.clients?.trade_name || job.clients?.legal_name || "Cliente";
}

/** Linha curta embaixo do status na fila ("Aguardando o PC Alex"), com o que fazer no mouse. */
export function PcWaitLine({ job, wait, now }: { job: AutomationJob; wait: PcWait; now: Date }) {
  const text = groupText(groupWaits([{ job, wait }])[0], now, clientName(job));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex max-w-full cursor-default items-center gap-1 text-[11px] text-(--c-9a6205)">
          <PowerOff className="size-3 shrink-0" />
          <span className="truncate">{text.title}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 space-y-1 text-xs">
        <p>{text.status}.</p>
        <p>
          <span className="font-medium">O que fazer:</span> {text.action}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
