"use client";

import { Check, ChevronDown, CircleCheck, Info, ListChecks, Loader2, Lock, Minus, ScanSearch } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { requestMalhaCheck, type MalhaCheckSummary } from "@/app/actions/malhas";
import { ListEmptyText, Segmented, SearchBox } from "@/components/data-list";
import { ToneBadge } from "@/components/status-badge";
import { normalizeCNPJ } from "@/lib/cnpj";
import { formatDateTime, formatRelative } from "@/lib/format";
import {
  MALHA_SOURCE_LABEL,
  MALHA_STATE_LABEL,
  MALHA_STATE_TONE,
  formatBRL,
  isProblem,
  latestJob,
  malhaRowState,
  malhasLabel,
  type MalhaCheckJob,
  type MalhaRowState,
} from "@/lib/malhas";
import { createClient } from "@/lib/supabase/client";
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

type Filter = "all" | "clean" | "problem" | "missing";

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 md:grid-cols-[28px_minmax(0,1.6fr)_minmax(0,1.1fr)_110px_minmax(0,1fr)_24px]";

const HOW_IT_WORKS = [
  "O robô entra no SIAT de cada cliente e abre Autoatendimento → Malhas Fiscais → Consulta de Malhas.",
  "Confere que a inscrição estadual da página é a do cliente, clica em Consulta e lê as tabelas DIEF/PGDAS e EFD/OIE: identificação da malha, períodos, ICMS devido/destacado e quantidade de NF-e.",
  "Só leitura: a lupa de cada malha não é aberta e nada é alterado. A consulta mostra o que está em aberto agora; peça de novo quando quiser atualizar.",
];

function StateBadge({ state }: { state: MalhaRowState }) {
  if (state === "not_checked") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-dashed border-(--c-d9d9d4) px-2 py-px text-xs whitespace-nowrap text-(--c-6b6c66)">
        <span className="size-1.5 rounded-full bg-(--c-c9c9c4)" />
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

export function MalhasBoard({
  clients,
  checks,
  jobs,
  canRun,
}: {
  clients: MalhaClient[];
  checks: MalhaCheck[];
  jobs: MalhaCheckJob[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
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
      })
      .subscribe();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  const rows = useMemo(() => {
    const checkBy = new Map(checks.map((c) => [c.client_id, c]));
    const jobsBy = new Map<string, MalhaCheckJob[]>();
    for (const j of jobs) jobsBy.set(j.client_id, [...(jobsBy.get(j.client_id) ?? []), j]);
    return clients.map((c) => {
      const check = checkBy.get(c.id) ?? null;
      const clientJobs = jobsBy.get(c.id) ?? [];
      const state = malhaRowState(check, clientJobs);
      const lockReason = !canRun
        ? "sem permissão"
        : !c.certificate_ok
          ? "sem certificado válido"
          : state === "checking"
            ? "já na fila"
            : null;
      return { client: c, check, state, lastJob: latestJob(clientJobs), lockReason };
    });
  }, [clients, checks, jobs, canRun]);

  const term = q.trim().toLowerCase();
  const digits = normalizeCNPJ(term).toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "clean" && r.state !== "clean") return false;
    if (filter === "problem" && !isProblem(r.state)) return false;
    if (filter === "missing" && r.state !== "not_checked") return false;
    if (!term) return true;
    const c = r.client;
    return (
      `${c.client_code} ${c.name} ${c.legal_name}`.toLowerCase().includes(term) ||
      (digits.length >= 3 && c.cnpj.toLowerCase().includes(digits))
    );
  });

  const selectable = visible.filter((r) => !r.lockReason);
  const chosen = rows.filter((r) => !r.lockReason && selected.has(r.client.id));
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.client.id));
  const someOn = selectable.some((r) => selected.has(r.client.id));
  const count = (f: (s: MalhaRowState) => boolean) => rows.filter((r) => f(r.state)).length;
  const totalMalhas = rows.reduce((n, r) => n + (r.check?.total ?? 0), 0);
  const totalIcms = rows.reduce((n, r) => n + Number(r.check?.icms_total ?? 0), 0);
  const notChecked = rows.filter((r) => !r.lockReason && ["not_checked", "check_failed"].includes(r.state));

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

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
        <section className="flex flex-wrap items-center gap-2 rounded-xl border bg-card shadow-card px-[18px] py-4">
          {(
            [
              ["Sem malha", count((s) => s === "clean"), "bg-(--c-f3faf6) text-(--c-1c5e3c)"],
              ["Com malha", count((s) => s === "findings"), "bg-(--c-fdecec) text-(--c-b42323)"],
              ["Malhas em aberto", totalMalhas, "bg-(--c-fdf4e3) text-(--c-9a6205)"],
              ["Sem resultado", count((s) => s === "not_checked" || s === "check_failed"), "bg-(--c-fafaf8) text-(--c-4a4b46)"],
            ] as const
          ).map(([label, n, cls]) => (
            <div key={label} className={cn("flex min-w-[96px] flex-col gap-0.5 rounded-lg px-3 py-2", cls)}>
              <span className="text-lg leading-none font-semibold tabular-nums">{n}</span>
              <span className="text-[11px] opacity-80">{label}</span>
            </div>
          ))}
          {totalIcms > 0 ? (
            <div className="ml-auto flex flex-col gap-0.5 text-right">
              <span className="text-lg leading-none font-semibold tabular-nums">{formatBRL(totalIcms)}</span>
              <span className="text-[11px] text-(--c-6b6c66)">ICMS devido/destacado nas malhas</span>
            </div>
          ) : null}
        </section>

        <section className="overflow-hidden rounded-xl border bg-card shadow-card">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
            <SearchBox value={q} onChange={setQ} placeholder="Buscar cliente, código ou CNPJ" />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                ["all", "Todos", rows.length],
                ["clean", "Sem malha", count((s) => s === "clean")],
                ["problem", "Com problema", count(isProblem)],
                ["missing", "Não consultados", count((s) => s === "not_checked")],
              ]}
            />
          </div>
          <div
            className={cn(
              ROW_GRID,
              "items-center border-b border-(--c-efefeb) bg-(--c-fafaf8) px-3.5 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
            )}
          >
            <button
              type="button"
              aria-label={allOn ? "Desmarcar todos" : "Selecionar todos"}
              onClick={() => {
                setResult(null);
                setSelected((prev) => {
                  const n = new Set(prev);
                  selectable.forEach((r) => (allOn ? n.delete(r.client.id) : n.add(r.client.id)));
                  return n;
                });
              }}
              disabled={selectable.length === 0}
              className={cn(
                "box-border grid size-4 place-items-center rounded border-[1.5px] text-white disabled:opacity-40",
                someOn ? "border-primary bg-primary" : "border-(--c-cfcfca) bg-card",
              )}
            >
              {allOn ? <Check className="size-[11px]" /> : someOn ? <Minus className="size-[11px]" /> : null}
            </button>
            <span>Cliente</span>
            <span className="text-right md:text-left">Situação</span>
            <span className="hidden text-right md:block">ICMS</span>
            <span className="hidden md:block">Última consulta</span>
            <span className="hidden md:block" />
          </div>

          {visible.length === 0 ? (
            <ListEmptyText>Nenhum cliente encontrado.</ListEmptyText>
          ) : (
            visible.map((r) => {
              const c = r.client;
              const on = !r.lockReason && selected.has(c.id);
              const expanded = open === c.id;
              const hint =
                r.state === "findings" && r.check
                  ? `${malhasLabel(r.check.total)} · ${r.check.findings.map((f) => f.identification).join("; ")}`
                  : r.state === "check_failed"
                    ? (r.lastJob?.error_message ?? r.lastJob?.last_message ?? "")
                    : "";
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
                      disabled={!!r.lockReason}
                      title={r.lockReason ?? undefined}
                      onClick={() => toggle(c.id)}
                      className={cn(
                        "box-border grid size-4 place-items-center rounded border-[1.5px] text-white disabled:cursor-not-allowed",
                        on ? "border-primary bg-primary" : r.lockReason ? "border-(--c-cfcfca) bg-(--c-f3f3f0)" : "border-(--c-cfcfca) bg-card",
                      )}
                    >
                      {on ? <Check className="size-[11px]" /> : r.lockReason ? <Lock className="size-[9px] text-(--c-6b6c66)" /> : null}
                    </button>
                    <button type="button" onClick={() => setOpen(expanded ? null : c.id)} className="flex w-full min-w-0 flex-col gap-px text-left">
                      <span className="truncate text-[13px] font-medium" title={c.name}>
                        {c.name}
                      </span>
                      <span className="truncate text-[11.5px] text-(--c-6b6c66)">
                        <span className="font-mono">{c.client_code}</span>
                        {r.lockReason && r.lockReason !== "já na fila" ? ` · ${r.lockReason}` : ""}
                      </span>
                    </button>
                    <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
                      <StateBadge state={r.state} />
                      {hint ? <span className="max-w-full truncate text-[11px] text-(--c-6b6c66)">{hint}</span> : null}
                    </div>
                    <span className="hidden text-right text-xs tabular-nums md:block">
                      {r.check && r.check.total > 0 ? formatBRL(r.check.icms_total) : "—"}
                    </span>
                    <div className="hidden min-w-0 flex-col gap-px md:flex">
                      {r.check ? (
                        <>
                          <span className="text-xs tabular-nums">{formatDateTime(r.check.checked_at)}</span>
                          <span className="truncate text-[11px] text-(--c-6b6c66)">{formatRelative(r.check.checked_at)}</span>
                        </>
                      ) : (
                        <span className="text-xs text-(--c-6b6c66)">—</span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={expanded ? "Fechar detalhes" : "Ver detalhes"}
                      onClick={() => setOpen(expanded ? null : c.id)}
                      className="hidden size-6 place-items-center rounded-md text-(--c-6b6c66) hover:bg-(--c-f2f3ef) md:grid"
                    >
                      <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
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
        </section>
      </div>

      <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 lg:sticky lg:top-20">
        <section className="flex flex-col gap-3.5 rounded-xl border bg-card shadow-card px-[18px] py-4">
          <p className="text-[14.5px] font-semibold">Consultar no SIAT</p>
          <div className="flex items-baseline gap-2 rounded-lg bg-(--c-fafaf8) p-2.5">
            <span className="text-[22px] font-semibold tabular-nums">{chosen.length}</span>
            <span className="text-[12px] text-(--c-6b6c66)">cliente(s) selecionado(s)</span>
          </div>
          {canRun && notChecked.length > 0 && !notChecked.every((r) => selected.has(r.client.id)) ? (
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setSelected(new Set(notChecked.map((r) => r.client.id)));
              }}
              className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-primary hover:underline"
            >
              <ListChecks className="size-3.5" /> Selecionar os sem resultado ({notChecked.length})
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canRun || chosen.length === 0 || pending}
            onClick={submit}
            className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-4" />}
            Consultar malhas no SIAT
          </button>
          {!canRun ? <p className="text-xs text-(--c-6b6c66)">Seu perfil só visualiza os resultados.</p> : null}
          {result ? (
            <div className="flex items-start gap-2 rounded-lg bg-(--c-eef7f1) px-2.5 py-[9px] text-[12.5px] text-(--c-1c5e3c)">
              <CircleCheck className="mt-px size-3.5 shrink-0" />
              <span>
                {result.created} consulta(s) na fila.
                {result.skipped ? ` ${result.skipped} já estava(m) na fila.` : ""} O resultado aparece aqui sozinho.
              </span>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2.5 rounded-xl border bg-card shadow-card px-[18px] py-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Info className="size-3.5 text-(--c-6b6c66)" /> Como funciona
          </p>
          {HOW_IT_WORKS.map((t, i) => (
            <div key={t} className="flex gap-2.5 text-xs leading-[1.45] text-(--c-4a4b46)">
              <span className="font-mono text-(--c-6b6c66)">{String(i + 1).padStart(2, "0")}</span>
              <span>{t}</span>
            </div>
          ))}
          <p className="mt-1 border-t border-dashed pt-2.5 text-[11.5px] text-(--c-4a4b46)">
            Malhas intimadas pelo DT-e não aparecem nesta página do SIAT; para essas, veja o e-AGEAT → Malhas Fiscais →
            Manifestação do Contribuinte.
          </p>
        </section>
      </aside>
    </div>
  );
}
