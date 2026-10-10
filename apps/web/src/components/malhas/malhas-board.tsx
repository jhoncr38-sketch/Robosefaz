"use client";

import { ChevronDown, CircleCheck, ListChecks, Loader2, Lock, ScanSearch, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { requestMalhaCheck, type MalhaCheckSummary } from "@/app/actions/malhas";
import { ListEmptyText } from "@/components/data-list";
import { CheckAll, CheckBox, LockedGroup, type LockedRow, StatusTabs, StickyBar } from "@/components/list-extras";
import { ToneBadge } from "@/components/status-badge";
import { normalizeCNPJ } from "@/lib/cnpj";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  MALHA_SOURCE_LABEL,
  MALHA_STATE_LABEL,
  MALHA_STATE_TONE,
  compareMalhaRows,
  findingsSummary,
  formatBRL,
  latestJob,
  malhaRowState,
  type MalhaCheckJob,
  type MalhaRowState,
  type MalhaTab,
} from "@/lib/malhas";
import { createClient, subscribeWithAuth } from "@/lib/supabase/client";
import type { MalhaCheck, MalhaFinding } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface MalhaClient {
  id: string;
  client_code: string;
  name: string;
  legal_name: string;
  cnpj: string;
  certificate_ok: boolean;
}

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)] gap-3 md:grid-cols-[28px_minmax(150px,1.4fr)_minmax(170px,1.5fr)_110px_24px]";

function StateBadge({ state }: { state: MalhaRowState }) {
  if (state === "not_checked") {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-[5px] border border-dashed border-(--c-d9d9d4) px-2 py-px text-xs whitespace-nowrap text-(--c-6b6c66)">
        <span className="size-1.5 shrink-0 rounded-full bg-(--c-c9c9c4)" />
        {MALHA_STATE_LABEL.not_checked}
      </span>
    );
  }
  return <ToneBadge tone={MALHA_STATE_TONE[state]}>{MALHA_STATE_LABEL[state]}</ToneBadge>;
}

function FindingsTable({ findings }: { findings: MalhaFinding[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-(--c-ecece8) bg-card">
      <div className="grid grid-cols-[minmax(0,2fr)_80px_120px_70px] gap-3 border-b border-(--c-efefeb) bg-(--c-fafaf8) px-3 py-1.5 text-[11px] tracking-[0.04em] text-(--c-6b6c66) uppercase">
        <span>Malha</span>
        <span className="text-right">Períodos</span>
        <span className="text-right">ICMS</span>
        <span className="text-right">NF-e</span>
      </div>
      {findings.map((f, i) => (
        <div
          key={`${f.source}-${f.identification}-${i}`}
          className="grid grid-cols-[minmax(0,2fr)_80px_120px_70px] gap-3 border-b border-(--c-f2f2ef) px-3 py-2 text-[12.5px] last:border-b-0"
        >
          <span className="flex min-w-0 flex-col gap-px">
            <span className="truncate font-medium text-(--c-3d3e3a)">{f.identification}</span>
            <span className="text-[11px] text-(--c-6b6c66)">{MALHA_SOURCE_LABEL[f.source]}</span>
          </span>
          <span className="text-right tabular-nums">{f.periods ?? "—"}</span>
          <span className="text-right tabular-nums">{formatBRL(f.icms)}</span>
          <span className="text-right tabular-nums">{f.nfe_count ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

function CheckDetail({ check }: { check: MalhaCheck }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-(--c-4a4b46)">
        <span>
          <span className="text-(--c-6b6c66)">Consultado em </span>
          {formatDateTime(check.checked_at)}
        </span>
        {check.state_registration ? (
          <span>
            <span className="text-(--c-6b6c66)">IE </span>
            <span className="font-mono">{check.state_registration}</span>
          </span>
        ) : null}
        {check.legal_name ? (
          <span>
            <span className="text-(--c-6b6c66)">No SIAT: </span>
            {check.legal_name}
          </span>
        ) : null}
      </div>
      {check.findings.length > 0 ? (
        <FindingsTable findings={check.findings} />
      ) : (
        <p className="text-xs text-(--c-6b6c66)">Nenhuma malha em aberto nas tabelas DIEF/PGDAS e EFD/OIE.</p>
      )}
      {check.raw_text ? (
        <div>
          <button type="button" onClick={() => setShowText((v) => !v)} className="text-xs font-medium text-primary hover:underline">
            {showText ? "Esconder texto da página" : "Ver texto da página do SIAT"}
          </button>
          {showText ? (
            <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-(--c-fafaf8) p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-(--c-3d3e3a)">
              {check.raw_text}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Empresa só de serviço (sem SIAT): aparece só na lista dos que ficam fora, com o motivo. */
export interface NoSiatClient {
  id: string;
  client_code: string;
  name: string;
}

export function MalhasBoard({
  clients,
  noSiat = [],
  checks,
  jobs,
  canRun,
}: {
  clients: MalhaClient[];
  noSiat?: NoSiatClient[];
  checks: MalhaCheck[];
  jobs: MalhaCheckJob[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<MalhaTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [showLocked, setShowLocked] = useState(false);
  const [result, setResult] = useState<MalhaCheckSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // quando o robô termina uma consulta, recarrega os resultados
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("malhas")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "automation_jobs" }, (payload) => {
        const row = payload.new as { operations?: string[] };
        if (!row.operations?.includes("MALHA_CHECK")) return;
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => router.refresh(), 800);
      });
    const closeChannel = subscribeWithAuth(channel);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      closeChannel();
    };
  }, [router]);

  const rows = useMemo(() => {
    const checkBy = new Map(checks.map((c) => [c.client_id, c]));
    const jobsBy = new Map<string, MalhaCheckJob[]>();
    for (const j of jobs) jobsBy.set(j.client_id, [...(jobsBy.get(j.client_id) ?? []), j]);
    return clients
      .map((c) => {
        const check = checkBy.get(c.id) ?? null;
        const clientJobs = jobsBy.get(c.id) ?? [];
        const state = malhaRowState(check, clientJobs);
        const icms = check && check.total > 0 ? Number(check.icms_total ?? 0) : 0;
        return { client: c, check, state, icms, name: c.name, lastJob: latestJob(clientJobs), noCert: !c.certificate_ok };
      })
      .sort(compareMalhaRows);
  }, [clients, checks, jobs]);

  const term = q.trim().toLowerCase();
  const digits = normalizeCNPJ(term).toLowerCase();
  const matches = (r: (typeof rows)[number]) => {
    if (!term) return true;
    const c = r.client;
    return (
      `${c.client_code} ${c.name} ${c.legal_name}`.toLowerCase().includes(term) ||
      (digits.length >= 3 && c.cnpj.toLowerCase().includes(digits))
    );
  };
  const inTab = rows.filter((r) => tab === "all" || r.state === tab);
  // sem certificado e nunca consultado: vai para o grupo dos bloqueados no fim da lista
  const hidden = (r: (typeof rows)[number]) => r.noCert && r.state === "not_checked";
  const visible = inTab.filter((r) => !hidden(r) && matches(r));
  const locked = inTab.filter((r) => hidden(r) && matches(r));
  const lockedOf = (r: (typeof rows)[number]) =>
    !canRun ? "sem permissão" : r.noCert ? "sem certificado válido" : r.state === "checking" ? "já na fila" : null;

  const selectable = visible.filter((r) => !lockedOf(r));
  const chosen = rows.filter((r) => !lockedOf(r) && selected.has(r.client.id));
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.client.id));
  const someOn = selectable.some((r) => selected.has(r.client.id));
  const count = (s: MalhaRowState) => rows.filter((r) => r.state === s).length;
  const missing = rows.filter((r) => !lockedOf(r) && (r.state === "not_checked" || r.state === "check_failed"));

  function toggle(id: string) {
    setResult(null);
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function submit() {
    const ids = chosen.map((r) => r.client.id);
    startTransition(async () => {
      const res = await requestMalhaCheck({ client_ids: ids });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResult(res.data ?? null);
      setSelected(new Set());
      router.refresh();
    });
  }

  const lockedRows: LockedRow[] = [
    ...locked.map((r) => ({
      id: r.client.id,
      name: r.client.name,
      code: r.client.client_code,
      reason: "sem certificado válido",
      danger: true,
      action: { label: "Renovar certificado", href: `/clients/${r.client.id}` },
    })),
    // empresas só de serviço (sem SIAT): nunca entram nesta consulta
    ...noSiat
      .filter((c) => !term || `${c.client_code} ${c.name}`.toLowerCase().includes(term))
      .map((c) => ({
        id: c.id,
        name: c.name,
        code: c.client_code,
        reason: "sem inscrição estadual (só NFS-e)",
        danger: false,
        action: { label: "Ver cadastro", href: `/clients/${c.id}` },
      })),
  ];

  return (
    <section className="overflow-clip rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
        <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
          <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar cliente, código ou CNPJ"
            aria-label="Buscar cliente, código ou CNPJ"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ellipsis outline-none placeholder:text-(--c-6b6c66)"
          />
        </div>
      </div>
      <div className="border-b border-(--c-efefeb) px-3.5 py-2">
        <StatusTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "Todos", count: rows.length },
            { key: "findings", label: "Com malha", count: count("findings"), color: "#dc3b3b" },
            { key: "check_failed", label: "Erro na consulta", count: count("check_failed"), color: "#f97316" },
            { key: "not_checked", label: "Não consultados", count: count("not_checked"), color: "#d4d4cf" },
            { key: "clean", label: "Sem malha", count: count("clean"), color: "#2ea062" },
          ]}
        />
      </div>
      <div
        className={cn(
          ROW_GRID,
          "items-center border-b border-(--c-efefeb) bg-(--c-fafaf8) px-3.5 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
        )}
      >
        <CheckAll
          all={allOn}
          some={someOn}
          disabled={selectable.length === 0}
          onToggle={() => {
            setResult(null);
            setSelected((prev) => {
              const n = new Set(prev);
              selectable.forEach((r) => (allOn ? n.delete(r.client.id) : n.add(r.client.id)));
              return n;
            });
          }}
        />
        <span>Cliente</span>
        <span className="text-right md:text-left">Situação</span>
        <span className="hidden text-right md:block">ICMS</span>
        <span className="hidden md:block" />
      </div>

      {visible.length === 0 && lockedRows.length === 0 ? (
        <ListEmptyText>Nenhum cliente encontrado.</ListEmptyText>
      ) : (
        visible.map((r) => {
          const c = r.client;
          const lock = lockedOf(r);
          const on = !lock && selected.has(c.id);
          const expanded = open === c.id;
          const hint =
            r.state === "findings" && r.check
              ? { text: findingsSummary(r.check), danger: false }
              : r.state === "check_failed"
                ? { text: r.lastJob?.error_message ?? r.lastJob?.last_message ?? "erro na consulta", danger: true }
                : r.state === "clean" && r.check
                  ? { text: `consultado ${formatRelative(r.check.checked_at)}`, danger: false }
                  : null;
          return (
            <Fragment key={c.id}>
              <div
                className={cn(
                  ROW_GRID,
                  "items-center border-b border-(--c-f2f2ef) px-3.5 py-2.5",
                  on && "bg-(--c-f3faf6)",
                  expanded && "bg-(--c-fafaf8)",
                )}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`Selecionar ${c.name}`}
                  disabled={!!lock}
                  title={lock ?? undefined}
                  onClick={() => toggle(c.id)}
                  className="disabled:cursor-not-allowed"
                >
                  {lock && lock !== "sem permissão" ? (
                    <span className="box-border grid size-4 place-items-center rounded border-[1.5px] border-(--c-cfcfca) bg-(--c-f3f3f0)">
                      <Lock className="size-[9px] text-(--c-6b6c66)" />
                    </span>
                  ) : (
                    <CheckBox on={on} className={lock ? "opacity-40" : undefined} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : c.id)}
                  className="flex w-full min-w-0 flex-col gap-px text-left"
                >
                  <span className="truncate text-[13px] font-medium" title={c.name}>
                    {c.name}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-(--c-6b6c66)">
                    {c.client_code}
                    {r.noCert ? <span className="font-sans"> · sem certificado válido</span> : null}
                  </span>
                </button>
                <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
                  <StateBadge state={r.state} />
                  {hint ? (
                    <span
                      className={cn(
                        "line-clamp-2 max-w-full text-[11.5px] leading-[1.3] text-pretty",
                        hint.danger ? "text-(--c-b42323)" : "text-(--c-6b6c66)",
                      )}
                      title={hint.text}
                    >
                      {hint.text}
                    </span>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "hidden text-right tabular-nums md:block",
                    r.icms > 0 ? "text-[12.5px] font-semibold text-(--c-b42323)" : "text-xs text-(--c-c9c9c4)",
                  )}
                >
                  {r.icms > 0 ? formatBRL(r.icms) : "—"}
                </span>
                <button
                  type="button"
                  aria-label={expanded ? "Fechar detalhes" : "Ver detalhes"}
                  onClick={() => setOpen(expanded ? null : c.id)}
                  className="hidden size-6 place-items-center rounded-md text-(--c-6b6c66) hover:bg-(--c-f2f3ef) md:grid"
                >
                  <ChevronDown className={cn("size-4 transition-transform duration-200", expanded && "rotate-180")} />
                </button>
              </div>
              {expanded ? (
                <div className="flex flex-col gap-2.5 border-b border-(--c-f2f2ef) bg-(--c-fafaf8) px-3.5 py-3 md:pl-[54px]">
                  {r.check ? (
                    <CheckDetail check={r.check} />
                  ) : (
                    <p className="text-xs text-(--c-6b6c66)">
                      {r.state === "checking"
                        ? "O robô vai abrir a Consulta de Malhas deste cliente em instantes."
                        : r.state === "check_failed"
                          ? `A consulta falhou: ${r.lastJob?.error_message ?? r.lastJob?.last_message ?? "veja o Histórico."}`
                          : "Este cliente ainda não teve as malhas consultadas."}
                    </p>
                  )}
                </div>
              ) : null}
            </Fragment>
          );
        })
      )}

      <LockedGroup
        title={`${lockedRows.length} ${lockedRows.length === 1 ? "fica" : "ficam"} fora desta consulta`}
        rows={lockedRows}
        open={showLocked}
        onToggle={() => setShowLocked((v) => !v)}
      />

      {result ? (
        <StickyBar success>
          <CircleCheck className="size-4 shrink-0 text-(--c-1c7a47)" />
          <span className="min-w-0 flex-1 text-[13px] text-(--c-1c5e3c)">
            <b className="font-semibold">{result.created} consulta(s) na fila.</b>
            {result.skipped ? ` ${result.skipped} já estava(m) na fila.` : ""} O resultado aparece aqui sozinho.
          </span>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="flex h-8 items-center rounded-[7px] border border-(--c-d3ebdc) bg-card px-3 text-[12.5px] text-primary hover:bg-(--c-eef7f1)"
          >
            Consultar mais
          </button>
        </StickyBar>
      ) : (
        <StickyBar>
          {!canRun ? (
            <span className="text-[12.5px] text-(--c-6b6c66)">Seu perfil só visualiza os resultados.</span>
          ) : (
            <>
              {missing.length > 0 && !missing.every((r) => selected.has(r.client.id)) ? (
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setSelected(new Set(missing.map((r) => r.client.id)));
                  }}
                  className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
                >
                  <ListChecks className="size-3.5" /> Selecionar os sem resultado
                </button>
              ) : null}
              <span className="flex-1" />
              <span className="text-[13px] whitespace-nowrap text-(--c-4a4b46)">
                <b className="font-semibold text-foreground">{chosen.length}</b> cliente(s)
              </span>
              <button
                type="button"
                disabled={chosen.length === 0 || pending}
                onClick={submit}
                className="flex h-[38px] items-center gap-2 rounded-lg bg-primary px-4 text-[13.5px] font-medium whitespace-nowrap text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-[15px]" />}
                Consultar no SIAT
              </button>
            </>
          )}
        </StickyBar>
      )}
    </section>
  );
}
