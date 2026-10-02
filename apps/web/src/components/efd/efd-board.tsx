"use client";

import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileSearch,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Minus,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { requestEfdCheck, type EfdCheckSummary } from "@/app/actions/efd";
import { ListEmptyText, Segmented, SearchBox } from "@/components/data-list";
import { ToneBadge } from "@/components/status-badge";
import { normalizeCNPJ } from "@/lib/cnpj";
import { competenceBounds, currentCompetence, formatCompetence, shiftCompetence } from "@/lib/competence";
import {
  EFD_STATE_HINT,
  EFD_STATE_LABEL,
  EFD_STATE_TONE,
  efdRowState,
  isProblem,
  latestDeclaration,
  stillValidAfterRejectedRetif,
  type EfdCheckJob,
  type EfdRowState,
} from "@/lib/efd";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { EfdDeclaration } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface EfdClient {
  id: string;
  client_code: string;
  name: string;
  legal_name: string;
  cnpj: string;
  certificate_ok: boolean;
}

type Filter = "all" | "ok" | "problem" | "missing";

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 md:grid-cols-[28px_minmax(0,1.6fr)_minmax(0,1.3fr)_120px_minmax(0,1.2fr)_24px]";

const HOW_IT_WORKS = [
  "O robô entra no SIAT de cada cliente e abre o Domicílio Eletrônico (DT-e).",
  "Lê só as notificações “EPE - EFD” da competência: finalidade, se foi processada e as inconsistências. Nenhuma outra mensagem é aberta e nada é excluído.",
  "Ao abrir, o SIAT registra a data de leitura (como quando você abre à mão). As mensagens ficam visíveis no SIAT por cerca de 60 dias.",
];

function StateBadge({ state }: { state: EfdRowState }) {
  if (state === "not_checked") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-dashed border-(--c-d9d9d4) px-2 py-px text-xs whitespace-nowrap text-(--c-7a7b75)">
        <span className="size-1.5 rounded-full bg-(--c-c9c9c4)" />
        {EFD_STATE_LABEL.not_checked}
      </span>
    );
  }
  return <ToneBadge tone={EFD_STATE_TONE[state]}>{EFD_STATE_LABEL[state]}</ToneBadge>;
}

function DeclarationDetail({ decl }: { decl: EfdDeclaration }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-(--c-ecece8) bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-(--c-4a4b46)">
        <StateBadge state={decl.situation} />
        <span>
          <span className="text-(--c-9a9b94)">EPE </span>
          <span className="font-mono">{decl.epe_number}</span>
        </span>
        {decl.finalidade ? (
          <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase">
            {decl.finalidade}
          </span>
        ) : null}
        <span>
          <span className="text-(--c-9a9b94)">Recebida </span>
          {formatDateTime(decl.received_at)}
        </span>
        <span>
          <span className="text-(--c-9a9b94)">Processada </span>
          {formatDateTime(decl.processed_at)}
        </span>
      </div>
      {decl.inconsistencies.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {decl.inconsistencies.map((inc, i) => (
            <li key={`${inc.rule}-${i}`} className="flex gap-2.5 text-[12.5px] leading-snug">
              <ToneBadge tone={inc.type === 1 ? "red" : inc.type === 2 ? "orange" : "yellow"} className="h-fit shrink-0">
                Tipo {inc.type} · {inc.type_label}
              </ToneBadge>
              <span className="min-w-0 text-(--c-3d3e3a)">
                <span className="font-mono text-[11.5px] text-(--c-7a7b75)">{inc.rule}</span> {inc.description}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-(--c-7a7b75)">Nenhuma inconsistência.</p>
      )}
      {decl.raw_text ? (
        <div>
          <button type="button" onClick={() => setShowText((v) => !v)} className="text-xs font-medium text-primary hover:underline">
            {showText ? "Esconder mensagem completa" : "Ver mensagem completa"}
          </button>
          {showText ? (
            <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-(--c-fafaf8) p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-(--c-3d3e3a)">
              {decl.raw_text}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function EfdBoard({
  clients,
  declarations,
  jobs,
  competence,
  canRun,
}: {
  clients: EfdClient[];
  declarations: EfdDeclaration[];
  jobs: EfdCheckJob[];
  competence: string;
  canRun: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [result, setResult] = useState<EfdCheckSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // quando o robô termina uma consulta desta competência, recarrega os resultados
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`efd:${competence}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "automation_jobs" }, (payload) => {
        const row = payload.new as { operations?: string[]; competence?: string };
        if (!row.operations?.includes("EFD_CHECK") || row.competence !== competence) return;
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => router.refresh(), 800);
      })
      .subscribe();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [competence, router]);

  const rows = useMemo(() => {
    const declsBy = new Map<string, EfdDeclaration[]>();
    for (const d of declarations) declsBy.set(d.client_id, [...(declsBy.get(d.client_id) ?? []), d]);
    const jobsBy = new Map<string, EfdCheckJob[]>();
    for (const j of jobs) jobsBy.set(j.client_id, [...(jobsBy.get(j.client_id) ?? []), j]);
    return clients.map((c) => {
      const decls = declsBy.get(c.id) ?? [];
      const state = efdRowState(decls, jobsBy.get(c.id) ?? []);
      const lastJob = [...(jobsBy.get(c.id) ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      const lockReason = !canRun
        ? "sem permissão"
        : !c.certificate_ok
          ? "sem certificado válido"
          : state === "checking"
            ? "já na fila"
            : null;
      return { client: c, decls, latest: latestDeclaration(decls), state, lastJob, lockReason };
    });
  }, [clients, declarations, jobs, canRun]);

  const term = q.trim().toLowerCase();
  const digits = normalizeCNPJ(term).toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "ok" && r.state !== "processed") return false;
    if (filter === "problem" && !isProblem(r.state)) return false;
    if (filter === "missing" && !["not_checked", "no_message"].includes(r.state)) return false;
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
  const count = (f: (s: EfdRowState) => boolean) => rows.filter((r) => f(r.state)).length;
  const bounds = competenceBounds(competence);
  const maxCompetence = currentCompetence();
  const prev = shiftCompetence(competence, -1);
  const next = shiftCompetence(competence, 1);
  const notChecked = rows.filter((r) => !r.lockReason && ["not_checked", "no_message", "check_failed"].includes(r.state));

  function go(value: string | null) {
    if (!value || value > maxCompetence) return;
    router.push(`${pathname}?competence=${value}`);
  }

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
      const res = await requestEfdCheck({ client_ids: ids, competence });
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
        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-[18px] py-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] text-(--c-7a7b75)">Competência da EFD</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Competência anterior"
                onClick={() => go(prev)}
                className="grid h-8 w-[30px] place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef)"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <div className="flex h-8 min-w-[76px] items-center justify-center rounded-[7px] border border-input px-3 font-mono text-sm font-medium">
                {formatCompetence(competence)}
              </div>
              <button
                type="button"
                aria-label="Próxima competência"
                onClick={() => go(next)}
                disabled={!next || next > maxCompetence}
                className="grid h-8 w-[30px] place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef) disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight className="size-3.5" />
              </button>
              {bounds ? (
                <span className="ml-2 text-xs text-(--c-7a7b75)">
                  {bounds.start} a {bounds.end}
                </span>
              ) : null}
            </div>
          </div>
          <div className="hidden w-px self-stretch bg-(--c-efefeb) sm:block" />
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["Processadas", count((s) => s === "processed"), "bg-(--c-f3faf6) text-(--c-1c5e3c)"],
                ["Com malha/pendência", count((s) => s === "alert" || s === "pending"), "bg-(--c-fdf4e3) text-(--c-9a6205)"],
                ["Não processadas", count((s) => s === "not_processed" || s === "retif_rejected"), "bg-(--c-fdecec) text-(--c-b42323)"],
                ["Sem resultado", count((s) => ["not_checked", "no_message", "check_failed"].includes(s)), "bg-(--c-fafaf8) text-(--c-4a4b46)"],
              ] as const
            ).map(([label, n, cls]) => (
              <div key={label} className={cn("flex min-w-[96px] flex-col gap-0.5 rounded-lg px-3 py-2", cls)}>
                <span className="text-lg leading-none font-semibold tabular-nums">{n}</span>
                <span className="text-[11px] opacity-80">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
            <SearchBox value={q} onChange={setQ} placeholder="Buscar cliente, código ou CNPJ" />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                ["all", "Todos", rows.length],
                ["ok", "Processadas", count((s) => s === "processed")],
                ["problem", "Com problema", count(isProblem)],
                ["missing", "Sem resultado", count((s) => s === "not_checked" || s === "no_message")],
              ]}
            />
          </div>
          <div
            className={cn(
              ROW_GRID,
              "items-center border-b border-(--c-efefeb) bg-(--c-fafaf8) px-3.5 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-7a7b75) uppercase",
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
            <span className="text-right md:text-left">Situação da EFD</span>
            <span className="hidden md:block">Finalidade</span>
            <span className="hidden md:block">Processamento</span>
            <span className="hidden md:block" />
          </div>

          {visible.length === 0 ? (
            <ListEmptyText>Nenhum cliente encontrado.</ListEmptyText>
          ) : (
            visible.map((r) => {
              const c = r.client;
              const on = !r.lockReason && selected.has(c.id);
              const expanded = open === c.id;
              const stillValid = r.state === "retif_rejected" ? stillValidAfterRejectedRetif(r.decls) : null;
              const hint =
                stillValid
                  ? `vale a ${(stillValid.finalidade ?? "declaração").toLowerCase()} processada em ${formatDateTime(stillValid.processed_at)}`
                  : r.state === "check_failed"
                  ? r.lastJob?.error_message ?? r.lastJob?.last_message ?? ""
                  : r.latest && r.latest.inconsistencies.length > 0
                    ? `${r.latest.inconsistencies.length} inconsistência(s)`
                    : (EFD_STATE_HINT[r.state] ?? "");
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
                      {on ? <Check className="size-[11px]" /> : r.lockReason ? <Lock className="size-[9px] text-(--c-9a9b94)" /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : c.id)}
                      className="flex w-full min-w-0 flex-col gap-px text-left"
                    >
                      <span className="truncate text-[13px] font-medium" title={c.name}>
                        {c.name}
                      </span>
                      <span className="truncate text-[11.5px] text-(--c-7a7b75)">
                        <span className="font-mono">{c.client_code}</span>
                        {r.lockReason && r.lockReason !== "já na fila" ? ` · ${r.lockReason}` : ""}
                      </span>
                    </button>
                    <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
                      <StateBadge state={r.state} />
                      {hint ? <span className="max-w-full truncate text-[11px] text-(--c-9a9b94)">{hint}</span> : null}
                    </div>
                    <span className="hidden text-xs text-(--c-4a4b46) md:block">
                      {r.latest?.finalidade ? (
                        <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase">
                          {r.latest.finalidade}
                        </span>
                      ) : (
                        "—"
                      )}
                    </span>
                    <div className="hidden min-w-0 flex-col gap-px md:flex">
                      {r.latest ? (
                        <>
                          <span className="text-xs tabular-nums">{formatDateTime(r.latest.processed_at)}</span>
                          <span className="truncate font-mono text-[11px] text-(--c-9a9b94)">EPE {r.latest.epe_number}</span>
                        </>
                      ) : (
                        <span className="text-xs text-(--c-9a9b94)">—</span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={expanded ? "Fechar detalhes" : "Ver detalhes"}
                      onClick={() => setOpen(expanded ? null : c.id)}
                      className="hidden size-6 place-items-center rounded-md text-(--c-7a7b75) hover:bg-(--c-f2f3ef) md:grid"
                    >
                      <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
                    </button>
                  </div>
                  {expanded ? (
                    <div className="flex flex-col gap-2.5 border-b border-(--c-f2f2ef) bg-(--c-fafaf8) px-3.5 py-3 md:pl-[54px]">
                      {r.decls.length === 0 ? (
                        <p className="text-xs text-(--c-7a7b75)">
                          {r.state === "not_checked"
                            ? "Esta competência ainda não foi consultada para este cliente."
                            : r.state === "checking"
                              ? "O robô vai ler o DT-e deste cliente em instantes."
                              : r.state === "check_failed"
                                ? `A consulta falhou: ${r.lastJob?.error_message ?? r.lastJob?.last_message ?? "veja o Histórico."}`
                                : "Nenhuma mensagem de processamento da EFD desta competência no DT-e. A EFD pode não ter sido entregue, ou a mensagem já expirou (o SIAT mantém por cerca de 60 dias)."}
                        </p>
                      ) : (
                        [...r.decls]
                          .sort((a, b) => (b.processed_at ?? "").localeCompare(a.processed_at ?? ""))
                          .map((d) => <DeclarationDetail key={d.id} decl={d} />)
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
        <section className="flex flex-col gap-3.5 rounded-xl border bg-card px-[18px] py-4">
          <p className="text-[14.5px] font-semibold">Consultar no SIAT</p>
          <div className="flex items-baseline gap-2 rounded-lg bg-(--c-fafaf8) p-2.5">
            <span className="text-[22px] font-semibold tabular-nums">{chosen.length}</span>
            <span className="text-[12px] text-(--c-7a7b75)">cliente(s) selecionado(s) · {formatCompetence(competence)}</span>
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
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <FileSearch className="size-4" />}
            Consultar processamento de EFD
          </button>
          {!canRun ? <p className="text-xs text-(--c-7a7b75)">Seu perfil só visualiza os resultados.</p> : null}
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

        <section className="flex flex-col gap-2.5 rounded-xl border bg-card px-[18px] py-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Info className="size-3.5 text-(--c-7a7b75)" /> Como funciona
          </p>
          {HOW_IT_WORKS.map((t, i) => (
            <div key={t} className="flex gap-2.5 text-xs leading-[1.45] text-(--c-4a4b46)">
              <span className="font-mono text-(--c-9a9b94)">{String(i + 1).padStart(2, "0")}</span>
              <span>{t}</span>
            </div>
          ))}
          <div className="mt-1 flex flex-col gap-1 border-t border-dashed pt-2.5 text-[11.5px] text-(--c-4a4b46)">
            <span>
              <b>Tipo 1 · Impeditiva:</b> EFD não processada, sem validade para a SEFAZ-PI.
            </span>
            <span>
              <b>Tipo 2 · Pendência:</b> processada; regularizar em até 45 dias.
            </span>
            <span>
              <b>Tipo 3 · Alerta:</b> processada; pode ser analisada por Auditor Fiscal (malha).
            </span>
          </div>
        </section>
      </aside>
    </div>
  );
}
