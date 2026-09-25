import { CheckCircle2, CircleSlash, Server } from "lucide-react";
import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { ToneBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { AppSetting, WorkerHeartbeat } from "@/lib/types";
import { WORKER_API_URL, workerHealth } from "@/lib/worker-api";

export const metadata: Metadata = { title: "Configurações" };

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <CircleSlash className="size-4 text-red-500" />}
      {label}
    </div>
  );
}

export default async function SettingsPage() {
  const { profile } = await requireSession();
  const supabase = await createClient();
  const [settingsRes, hbRes, health] = await Promise.all([
    supabase.from("app_settings").select("*").order("key"),
    supabase.from("worker_heartbeats").select("*").order("last_seen_at", { ascending: false }).limit(10),
    workerHealth(),
  ]);
  const settings = (settingsRes.data ?? []) as AppSetting[];
  const workers = (hbRes.data ?? []) as WorkerHeartbeat[];
  const now = new Date().getTime();

  return (
    <>
      <PageHeader title="Configurações" description="Parâmetros da automação e estado dos serviços." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parâmetros</CardTitle>
            <CardDescription>
              {can(profile.role, "settings:write") ? "Alterações valem na próxima rodada do worker." : "Somente administradores podem alterar."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={settings} editable={can(profile.role, "settings:write")} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API do worker</CardTitle>
              <CardDescription className="font-mono text-xs">{WORKER_API_URL}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {health ? (
                <>
                  <Check ok={health.status === "ok"} label={`Status: ${health.status}`} />
                  <Check ok={health.database} label="Banco de dados (Supabase)" />
                  <Check ok={health.browser} label="Navegador (Playwright)" />
                </>
              ) : (
                <Check ok={false} label="API indisponível — inicie com: uvicorn app.main:app --port 8000" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Workers</CardTitle>
              <CardDescription>Processos `python -m app.worker` conectados (heartbeat a cada 30s).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {workers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum worker registrou atividade ainda.</p>
              ) : (
                workers.map((w) => {
                  const online = w.status !== "stopped" && now - new Date(w.last_seen_at).getTime() < 120_000;
                  const meta = w.meta as Record<string, unknown>;
                  return (
                    <div key={w.worker_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                      <div className="flex items-center gap-3">
                        <Server className="size-4 text-muted-foreground" />
                        <div>
                          <p className="font-mono text-xs">{w.worker_id}</p>
                          <p className="text-xs text-muted-foreground">
                            modo {w.kind} · visto {formatRelative(w.last_seen_at)}
                            {meta.dry_run ? " · DRY-RUN" : ""}
                            {meta.headless === false ? " · navegador visível" : ""}
                          </p>
                        </div>
                      </div>
                      <ToneBadge tone={online ? (w.status === "busy" ? "blue" : "green") : "gray"}>
                        {online ? (w.status === "busy" ? "Processando" : "Online") : "Offline"}
                      </ToneBadge>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
