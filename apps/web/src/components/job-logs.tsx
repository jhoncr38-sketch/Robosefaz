"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { createClient } from "@/lib/supabase/client";
import type { AutomationLog } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_CLASS: Record<AutomationLog["level"], string> = {
  DEBUG: "text-zinc-400",
  INFO: "text-sky-700",
  WARNING: "text-amber-700",
  ERROR: "text-red-700",
};

/** Logs do job, atualizados em tempo real enquanto o robô executa. */
export function JobLogs({ jobId, initialLogs }: { jobId: string; initialLogs: AutomationLog[] }) {
  const [logs, setLogs] = useState(initialLogs);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`logs:${jobId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "automation_logs", filter: `job_id=eq.${jobId}` },
        (payload) => setLogs((prev) => [...prev, payload.new as AutomationLog]),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [jobId]);

  const visible = useMemo(() => logs.filter((l) => showDebug || l.level !== "DEBUG"), [logs, showDebug]);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b py-4">
        <CardTitle className="text-base">Logs ({visible.length})</CardTitle>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={showDebug} onCheckedChange={(v) => setShowDebug(v === true)} /> Mostrar DEBUG
        </label>
      </CardHeader>
      <CardContent className="max-h-[480px] overflow-y-auto p-0">
        {visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Sem logs.</p>
        ) : (
          <ol className="divide-y font-mono text-xs">
            {visible.map((l) => (
              <li key={l.id} className="grid grid-cols-[70px_64px_150px_1fr] gap-3 px-4 py-1.5">
                <span className="text-muted-foreground">{format(new Date(l.created_at), "HH:mm:ss")}</span>
                <span className={cn("font-semibold", LEVEL_CLASS[l.level])}>{l.level}</span>
                <span className="truncate text-muted-foreground" title={l.step ?? ""}>
                  {l.step ?? "—"}
                </span>
                <span className="break-words whitespace-pre-wrap">{l.message}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
