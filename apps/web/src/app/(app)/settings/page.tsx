import { CheckCircle2, CircleSlash, Server } from "lucide-react";
import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { ToneBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { AppSetting, WorkerHeartbeat } from "@/lib/types";
import { WORKER_API_URL, workerHealth } from "@/lib/worker-api";

export const metadata: Metadata = { title: "Configurações" };

// Versão publicada mais recente do robô (aba Releases do GitHub), revalidada a cada hora.
const RELEASES_REPO = process.env.ROBOT_RELEASES_REPO || "jhoncr38-sketch/Robosefaz";

async function latestRobotVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ? data.tag_name.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

function olderThan(version: string, latest: string): boolean {
  const a = version.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

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
  const [settingsRes, hbRes, health, latest] = await Promise.all([
    supabase.from("app_settings").select("*").order("key"),
    supabase.from("worker_heartbeats").select("*").order("last_seen_at", { ascending: false }).limit(100),
    workerHealth(),
    latestRobotVersion(),
  ]);
  const settings = (settingsRes.data ?? []) as AppSetting[];
  // um cartão por computador: o registro mais recente de cada um
  const seen = new Set<string>();
  const workers = ((hbRes.data ?? []) as WorkerHeartbeat[]).filter((w) => {
    const host = w.hostname || w.worker_id;
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
  const now = new Date().getTime();

  return (
    <>
      <PageHeader title="Configurações" description="Parâmetros da automação e estado dos serviços." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parâmetros</CardTitle>
            <CardDescription>
              {profile.is_platform_owner
                ? "Valem para os robôs de todos os escritórios, na próxima rodada."
                : "Parâmetros gerais da plataforma; somente o dono da plataforma altera."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={settings} editable={profile.is_platform_owner} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          {health ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">API do worker</CardTitle>
                <CardDescription className="font-mono text-xs">{WORKER_API_URL}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Check ok={health.status === "ok"} label={`Status: ${health.status}`} />
                <Check ok={health.database} label="Banco de dados (Supabase)" />
                <Check ok={health.browser} label="Navegador (Playwright)" />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Computadores com o robô</CardTitle>
              <CardDescription>
                Cada robô dá sinal a cada 30 segundos.
                {latest ? ` Versão mais recente publicada: ${latest}.` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {workers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum worker registrou atividade ainda.</p>
              ) : (
                workers.map((w) => {
                  const online = w.status !== "stopped" && now - new Date(w.last_seen_at).getTime() < 120_000;
                  const meta = w.meta as Record<string, unknown>;
                  const version = typeof meta.version === "string" ? meta.version : null;
                  const outdated = Boolean(latest && (!version || olderThan(version, latest)));
                  return (
                    <div key={w.worker_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                      <div className="flex items-center gap-3">
                        <Server className="size-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{w.hostname || w.worker_id}</p>
                          <p className="text-xs text-muted-foreground">
                            versão {version ?? "anterior à 1.0.6"} · visto {formatRelative(w.last_seen_at)}
                            {meta.dry_run ? " · DRY-RUN" : ""}
                            {meta.headless === false ? " · navegador visível" : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {outdated ? (
                          <ToneBadge tone="yellow">Desatualizado · atualiza sozinho ao ligar ou quando ocioso</ToneBadge>
                        ) : null}
                        <ToneBadge tone={online ? (w.status === "busy" ? "blue" : "green") : "gray"}>
                          {online ? (w.status === "busy" ? "Processando" : "Online") : "Offline"}
                        </ToneBadge>
                      </div>
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
