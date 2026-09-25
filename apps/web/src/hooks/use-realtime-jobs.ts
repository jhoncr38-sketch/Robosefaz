"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { AutomationJob } from "@/lib/types";

const JOB_SELECT = "*, clients(client_code, legal_name, trade_name, cnpj)";

/**
 * Mantém a lista de jobs sincronizada via Supabase Realtime.
 * Quando o worker atualiza um job, a linha é atualizada imediatamente na tela.
 */
export function useRealtimeJobs(initial: AutomationJob[], filter?: (job: AutomationJob) => boolean) {
  const [jobs, setJobs] = useState<AutomationJob[]>(initial);
  const [connected, setConnected] = useState(false);
  const [prevInitial, setPrevInitial] = useState(initial);

  // Novos dados do servidor (router.refresh) substituem o estado local.
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setJobs(initial);
  }

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("automation_jobs:queue")
      .on("postgres_changes", { event: "*", schema: "public", table: "automation_jobs" }, async (payload) => {
        if (payload.eventType === "DELETE") {
          const oldId = (payload.old as { id?: string }).id;
          setJobs((prev) => prev.filter((j) => j.id !== oldId));
          return;
        }
        const row = payload.new as AutomationJob;
        if (payload.eventType === "INSERT") {
          const { data } = await supabase.from("automation_jobs").select(JOB_SELECT).eq("id", row.id).maybeSingle();
          const full = (data ?? row) as AutomationJob;
          if (filter && !filter(full)) return;
          setJobs((prev) => (prev.some((j) => j.id === full.id) ? prev : [full, ...prev]));
          return;
        }
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === row.id);
          if (idx === -1) {
            if (filter && !filter(row)) return prev;
            return [{ ...row, clients: null }, ...prev];
          }
          const next = [...prev];
          next[idx] = { ...prev[idx], ...row, clients: prev[idx].clients };
          if (filter && !filter(next[idx])) next.splice(idx, 1);
          return next;
        });
      })
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));
    return () => {
      void supabase.removeChannel(channel);
    };
    // o filtro é estável por página; não reassinar a cada render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { jobs, connected };
}
