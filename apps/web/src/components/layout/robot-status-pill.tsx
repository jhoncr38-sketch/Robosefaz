"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MANUAL_JOB_STATUSES } from "@/lib/status";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/** Mesmo critério da tela de Configurações: sinal nos últimos 2 minutos. */
const ONLINE_MS = 120_000;

type RobotState = "unknown" | "online" | "busy" | "offline";

/** Estado dos robôs do escritório e quantos trabalhos esperam uma ação sua (intervenção). */
export function useRobotState(): { state: RobotState; waitingYou: number } {
  const [state, setState] = useState<RobotState>("unknown");
  const [waitingYou, setWaitingYou] = useState(0);
  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    async function load() {
      const [{ data }, { count }] = await Promise.all([
        supabase.from("worker_heartbeats").select("status, last_seen_at"),
        supabase.from("automation_jobs").select("id", { count: "exact", head: true }).in("status", MANUAL_JOB_STATUSES),
      ]);
      if (!alive) return;
      const now = Date.now();
      const online = (data ?? []).filter(
        (w) => w.status !== "stopped" && now - new Date(w.last_seen_at).getTime() < ONLINE_MS,
      );
      setState(online.length === 0 ? "offline" : online.some((w) => w.status === "busy") ? "busy" : "online");
      setWaitingYou(count ?? 0);
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return { state, waitingYou };
}

const PILL =
  "hidden h-[30px] shrink-0 items-center gap-2 rounded-[15px] border px-3 text-[12.5px] whitespace-nowrap hover:no-underline sm:flex";

export function RobotStatusPill() {
  const { state, waitingYou } = useRobotState();
  if (waitingYou > 0) {
    return (
      <Link
        href="/queue?aba=intervencao"
        title="Há trabalho parado esperando uma ação sua no computador do robô"
        className={cn(PILL, "border-(--c-f6d5bd) bg-(--c-fdf3ea) font-medium text-(--c-b4530f)")}
      >
        <span className="warn-pulse size-2 shrink-0 rounded-full bg-(--c-f97316)" />
        Robô esperando você · {waitingYou}
      </Link>
    );
  }
  const on = state === "online" || state === "busy";
  return (
    <Link
      href="/dashboard"
      title={on ? "Algum computador com o robô deu sinal nos últimos 2 minutos" : "Nenhum computador com o robô ligado"}
      className={cn(
        PILL,
        on ? "border-(--c-d3ebdc) bg-(--c-eef7f1) text-(--c-1c5e3c)" : "border-(--c-e3e3df) bg-(--c-f3f3f0) text-(--c-6b6c66)",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", on ? "bg-(--c-2ea062)" : "bg-(--c-a3a39e)")} />
      {state === "unknown" ? "Robô…" : state === "busy" ? "Robô processando" : on ? "Robô ativo" : "Robô desligado"}
    </Link>
  );
}
