"use client";

import { ChevronDown, ChevronLeft, ChevronRight, CircleCheck, FileSearch, ListChecks, Loader2, Lock, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { requestEfdCheck, type EfdCheckSummary } from "@/app/actions/efd";
import { ListEmptyText } from "@/components/data-list";
import { CheckAll, CheckBox, LockedGroup, type LockedRow, StatusTabs, StickyBar } from "@/components/list-extras";
import { ToneBadge } from "@/components/status-badge";
import { normalizeCNPJ } from "@/lib/cnpj";
import { currentCompetence, formatCompetence, shiftCompetence } from "@/lib/competence";
import {
  EFD_SEVERITY,
  EFD_STATE_LABEL,
  EFD_STATE_TONE,
  efdHint,
  efdRowState,
  efdTab,
  latestDeclaration,
  type EfdCheckJob,
  type EfdRowState,
  type EfdTab,
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

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)] gap-3 md:grid-cols-[28px_minmax(150px,1.4fr)_minmax(190px,1.4fr)_minmax(130px,1fr)_24px]";

const HINT_TONE = {
  muted: "text-(--c-6b6c66)",
  danger: "font-medium text-(--c-b42323)",
  warn: "font-medium text-(--c-b4530f)",
} as const;

export function StateBadge({ state }: { state: EfdRowState }) {
  if (state === "not_checked") {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-[5px] border border-dashed border-(--c-d9d9d4) px-2 py-px text-xs whitespace-nowrap text-(--c-6b6c66)">
        <span className="size-1.5 shrink-0 rounded-full bg-(--c-c9c9c4)" />
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
          <span className="text-(--c-6b6c66)">EPE </span>
          <span className="font-mono">{decl.epe_number}</span>
        </span>
        {decl.finalidade ? (
          <span className="rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase">
            {decl.finalidade}
          </span>
        ) : null}
        <span>
          <span className="text-(--c-6b6c66)">Recebida </span>
          {formatDateTime(decl.received_at)}
        </span>
        <span>
          <span className="text-(--c-6b6c66)">Processada </span>
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
                <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{inc.rule}</span> {inc.description}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-(--c-6b6c66)">Nenhuma inconsistência.</p>
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
  const [tab, setTab] = useState<EfdTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [showLocked, setShowLocked] = useState(false);
  const [result, setResult] = useState<EfdCheckSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now] = useState(() => new Date());

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
    return clients
      .map((c) => {
        const decls = declsBy.get(c.id) ?? [];
        const clientJobs = jobsBy.get(c.id) ?? [];
        const state = efdRowState(decls, clientJobs);
        const lastJob = [...clientJobs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        return {
          client: c,
          decls,
          latest: latestDeclaration(decls),
          state,
          lastJob,
          hint: efdHint(state, decls, lastJob, now),
          // sem certificado e sem resultado: vai para o grupo dos bloqueados no fim da lista
          noCert: !c.certificate_ok,
        };
      })
      .sort(
        (a, b) =>
          EFD_SEVERITY.indexOf(a.state) - EFD_SEVERITY.indexOf(b.state) ||
          a.client.name.localeCompare(b.client.name, "pt-BR", { sensitivity: "base" }),
      );
  }, [clients, declarations, jobs, now]);

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
  const inTab = rows.filter((r) => tab === "all" || efdTab(r.state) === tab);
  const hidden = (r: (typeof rows)[number]) => r.noCert && r.state === "not_checked";
  const visible = inTab.filter((r) => !hidden(r) && matches(r));
  const locked = inTab.filter((r) => hidden(r) && matches(r));
  const lockedOf = (r: (typeof rows)[number]) =>
    !canRun ? "sem permissão" : r.noCert ? "sem certificado válido" : r.state === "checking" ? "já na fila" : null;

  const selectable = visible.filter((r) => !lockedOf(r));
  const chosen = rows.filter((r) => !lockedOf(r) && selected.has(r.client.id));
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.client.id));
  const someOn = selectable.some((r) => selected.has(r.client.id));
  const tabCount = (t: Exclude<EfdTab, "all">) => rows.filter((r) => efdTab(r.state) === t).length;
  const maxCompetence = currentCompetence();
  const prev = shiftCompetence(competence, -1);
  const next = shiftCompetence(competence, 1);
  const missing = rows.filter((r) => !lockedOf(r) && efdTab(r.state) === "missing");

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

  const lockedRows: LockedRow[] = locked.map((r) => ({
    id: r.client.id,
    name: r.client.name,
    code: r.client.client_code,
    reason: "sem certificado válido",
    danger: true,
    action: { label: "Renovar certificado", href: `/clients/${r.client.id}` },
  }));

  return (
    <section className="overflow-clip rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Competência anterior"
            onClick={() => go(prev)}
            className="grid h-8 w-7 place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef)"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <div className="flex h-8 min-w-[76px] items-center justify-center rounded-[7px] border border-input px-2.5 font-mono text-sm font-medium">
            {formatCompetence(competence)}
          </div>
          <button
            type="button"
            aria-label="Próxima competência"
            onClick={() => go(next)}
            disabled={!next || next > maxCompetence}
            className="grid h-8 w-7 place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef) disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
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
            { key: "not_processed", label: "Não processadas", count: tabCount("not_processed"), color: "#dc3b3b" },
            { key: "pending", label: "Pendência ou malha", count: tabCount("pending"), color: "#e0a019" },
            { key: "missing", label: "Sem resultado", count: tabCount("missing"), color: "#d4d4cf" },
            { key: "processed", label: "Processadas", count: tabCount("processed"), color: "#2ea062" },
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
        <span className="text-right md:text-left">Situação da EFD</span>
        <span className="hidden md:block">Processamento</span>
        <span className="hidden md:block" />
      </div>

      {visible.length === 0 && locked.length === 0 ? (
        <ListEmptyText>Nenhum cliente encontrado.</ListEmptyText>
      ) : (
        visible.map((r) => {
          const c = r.client;
          const lock = lockedOf(r);
          const on = !lock && selected.has(c.id);
          const expanded = open === c.id;
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
                  {r.hint ? (
                    <span
                      className={cn("line-clamp-2 max-w-full text-[11.5px] leading-[1.3] text-pretty", HINT_TONE[r.hint.tone])}
                      title={r.hint.text}
                    >
                      {r.hint.text}
                    </span>
                  ) : null}
                </div>
                <div className="hidden min-w-0 flex-col items-start gap-[3px] md:flex">
                  {r.latest ? (
                    <>
                      {r.latest.finalidade ? (
                        <span className="rounded bg-(--c-f2f2ef) px-1.5 py-px text-[10.5px] font-medium tracking-[0.03em] text-(--c-4a4b46) uppercase">
                          {r.latest.finalidade}
                        </span>
                      ) : null}
                      <span className="text-xs whitespace-nowrap tabular-nums">{formatDateTime(r.latest.processed_at)}</span>
                    </>
                  ) : (
                    <span className="text-xs text-(--c-c9c9c4)">—</span>
                  )}
                </div>
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
                  {r.decls.length === 0 ? (
                    <p className="text-xs text-(--c-6b6c66)">
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

      <LockedGroup
        title={`${lockedRows.length} sem certificado válido`}
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
                <b className="font-semibold text-foreground">{chosen.length}</b> cliente(s) · {formatCompetence(competence)}
              </span>
              <button
                type="button"
                disabled={chosen.length === 0 || pending}
                onClick={submit}
                className="flex h-[38px] items-center gap-2 rounded-lg bg-primary px-4 text-[13.5px] font-medium whitespace-nowrap text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <FileSearch className="size-[15px]" />}
                Consultar no SIAT
              </button>
            </>
          )}
        </StickyBar>
      )}
    </section>
  );
}
