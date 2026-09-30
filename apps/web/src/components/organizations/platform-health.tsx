import { Activity, Bot } from "lucide-react";

import { ListCard, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
import { EmptyState } from "@/components/page-header";
import { ToneBadge } from "@/components/status-badge";
import { formatShortAgo } from "@/lib/format";
import { HEALTH_LABEL, sortByHealth, type HealthLevel, type HealthRobot, type PlatformHealthRow } from "@/lib/health";
import { ERROR_CODE_LABEL, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

const TONE: Record<HealthLevel, Tone> = { problem: "red", attention: "yellow", ok: "green", idle: "gray" };

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 xl:grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1.3fr)_120px_80px_170px_80px]";

function Robots({ robots }: { robots: HealthRobot[] }) {
  if (robots.length === 0) return <span className="text-xs text-(--c-9a9b94)">—</span>;
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {robots.map((r) => {
        const online = r.online;
        return (
          <li key={r.name} className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
            <span
              className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-(--c-1fa37a)" : "bg-(--c-c9c9c4)")}
              title={online ? "Ligado agora" : "Sem sinal"}
              aria-hidden
            />
            <span className="truncate">{r.name}</span>
            <span
              className={cn(
                "shrink-0 rounded-[4px] px-1 font-mono text-[11px]",
                r.outdated ? "bg-(--c-fdf4e3) text-(--c-9a6205)" : "text-(--c-7a7b75)",
              )}
              title={r.outdated ? "Versão antiga: a atualização automática pode estar falhando" : undefined}
            >
              {r.version ?? "?"}
            </span>
            <span className="shrink-0 text-[11px] text-(--c-9a9b94)">{online ? "ligado" : formatShortAgo(r.last_seen_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Num({ warn, children }: { warn?: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("hidden text-right font-mono text-[12.5px] xl:block", warn && "font-medium text-(--c-b4530f)")}>
      {children}
    </span>
  );
}

export function PlatformHealth({ rows }: { rows: PlatformHealthRow[] }) {
  if (rows.length === 0) {
    return <EmptyState icon={<Activity />} title="Nenhum escritório" description="Crie um escritório para acompanhar a saúde." />;
  }
  const sorted = sortByHealth(rows);
  const count = (level: HealthLevel) => sorted.filter((r) => r.health.level === level).length;
  const robots = sorted.flatMap((r) => r.robots);
  const latest = sorted.find((r) => r.latest_version)?.latest_version;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-(--c-7a7b75)">Escritórios</p>
          <p className="mt-1 flex flex-wrap gap-1.5">
            {(["problem", "attention", "ok", "idle"] as HealthLevel[])
              .filter((l) => count(l) > 0)
              .map((l) => (
                <ToneBadge key={l} tone={TONE[l]}>
                  {count(l)} {HEALTH_LABEL[l].toLowerCase()}
                </ToneBadge>
              ))}
          </p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-(--c-7a7b75)">Robôs ligados agora</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {robots.filter((r) => r.online).length}
            <span className="text-sm font-normal text-(--c-9a9b94)"> de {robots.length}</span>
          </p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3">
          <p className="text-xs text-(--c-7a7b75)">Versão mais nova em uso</p>
          <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold">
            <Bot className="size-4 text-(--c-7a7b75)" />
            {latest ?? "—"}
          </p>
        </div>
      </div>

      <ListCard>
        <ListHead grid={GRID}>
          <span>Escritório</span>
          <span className="text-right xl:text-left">Situação</span>
          <span className="hidden xl:block">Robôs</span>
          <span className="hidden text-right xl:block">7 dias</span>
          <span className="hidden text-right xl:block">Parados</span>
          <span className="hidden text-right xl:block">Certificados</span>
          <span className="hidden text-right xl:block">Empresas</span>
        </ListHead>
        {sorted.map((org) => {
          const failures = Object.entries(org.failures_by_code ?? {}).sort((a, b) => b[1] - a[1]);
          const rate = org.health.successRate;
          const stopped = org.stuck + org.waiting_person + org.no_certificate;
          return (
            <ListRow key={org.org_id} grid={GRID}>
              <div className="flex min-w-0 flex-col gap-1">
                <PrimaryCell title={org.name} />
                {org.health.reasons.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 text-[11.5px] text-(--c-7a7b75)">
                    {org.health.reasons.map((r, i) => (
                      <li key={r} className={cn("first-letter:uppercase", i < org.health.problems && "text-(--c-b42323)")}>
                        {r}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {failures.length > 0 ? (
                  <p className="text-[11.5px] text-(--c-9a9b94)">
                    Falhas em 7 dias: {failures.map(([code, n]) => `${ERROR_CODE_LABEL[code] ?? code} ×${n}`).join(" · ")}
                  </p>
                ) : null}
                <div className="flex flex-col gap-1 xl:hidden">
                  <Robots robots={org.robots} />
                  <span className="text-[11.5px] text-(--c-7a7b75)">
                    7 dias: {org.completed_7d} concluído(s), {org.failed_7d} com falha · {stopped} parado(s) · {org.clients}/
                    {org.max_clients ?? "∞"} empresas
                  </span>
                </div>
              </div>
              <div className="flex justify-end xl:justify-start">
                <ToneBadge tone={TONE[org.health.level]}>{HEALTH_LABEL[org.health.level]}</ToneBadge>
              </div>
              <div className="hidden min-w-0 xl:block">
                <Robots robots={org.robots} />
              </div>
              <Num warn={rate !== null && rate < 0.8}>
                {org.completed_7d}✓ {org.failed_7d > 0 ? `${org.failed_7d}✗ ` : ""}
                <span className="text-(--c-9a9b94)">{rate === null ? "" : `${Math.round(rate * 100)}%`}</span>
              </Num>
              <Num warn={stopped > 0}>{stopped}</Num>
              <Num warn={org.certs_expired > 0 || org.certs_expiring > 0}>
                {org.certs_expired + org.certs_expiring > 0
                  ? `${org.certs_expired > 0 ? `${org.certs_expired} venc.` : ""}${org.certs_expired > 0 && org.certs_expiring > 0 ? " · " : ""}${org.certs_expiring > 0 ? `${org.certs_expiring} a vencer` : ""}`
                  : "ok"}
              </Num>
              <Num>
                {org.clients}
                <span className="text-(--c-9a9b94)">/{org.max_clients ?? "∞"}</span>
              </Num>
            </ListRow>
          );
        })}
      </ListCard>
      <p className="text-xs text-(--c-9a9b94)">
        Avisos no sino (dias úteis, das 8h às 18h): robô parado, desatualizado, falhas e trabalhos parados. Só números de
        funcionamento; clientes e notas de cada escritório continuam privados.
      </p>
    </div>
  );
}
