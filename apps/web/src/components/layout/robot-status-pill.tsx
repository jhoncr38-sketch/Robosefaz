"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/** Mesmo critério da tela de Configurações: sinal nos últimos 2 minutos. */
const ONLINE_MS = 120_000;

type RobotState = "unknown" | "online" | "busy" | "offline";

export function useRobotState(): RobotState {
  const [state, setState] = useState<RobotState>("unknown");
  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    async function load() {
      const { data } = await supabase.from("worker_heartbeats").select("status, last_seen_at");
      if (!alive) return;
      const now = Date.now();
      const online = (data ?? []).filter(
        (w) => w.status !== "stopped" && now - new Date(w.last_seen_at).getTime() < ONLINE_MS,
      );
      setState(online.length === 0 ? "offline" : online.some((w) => w.status === "busy") ? "busy" : "online");
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return state;
}

export function RobotStatusPill() {
  const state = useRobotState();
  const on = state === "online" || state === "busy";
  return (
    <Link
      href="/dashboard"
      title={on ? "Algum computador com o robô deu sinal nos últimos 2 minutos" : "Nenhum computador com o robô ligado"}
      className={cn(
        "hidden h-[30px] shrink-0 items-center gap-2 rounded-[15px] border px-3 text-[12.5px] whitespace-nowrap hover:no-underline sm:flex",
        on ? "border-(--c-d3ebdc) bg-(--c-eef7f1) text-(--c-1c5e3c)" : "border-(--c-e3e3df) bg-(--c-f3f3f0) text-(--c-6b6c66)",
      )}
    >
      {on ? <span className="live-dot" /> : <span className="size-2 rounded-full bg-(--c-a3a39e)" />}
      {state === "unknown" ? "Robô…" : state === "busy" ? "Robô processando" : on ? "Robô ativo" : "Robô desligado"}
    </Link>
  );
}
