"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Minus,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { createJobs, type BatchSummary } from "@/app/actions/automation";
import type { PlannerClient } from "@/components/automation/planner-types";
import { ToneBadge } from "@/components/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCNPJ, normalizeCNPJ } from "@/lib/cnpj";
import { competenceBounds, currentCompetence, formatCompetence, shiftCompetence } from "@/lib/competence";
import {
  blocksNewRequest,
  COMPETENCE_STATUS_LABEL,
  COMPETENCE_STATUS_TONE,
  statusMapFromJobs,
  type CompetenceStatusMap,
} from "@/lib/competence-status";
import { formatDate } from "@/lib/format";
import { EXPORT_OPERATIONS } from "@/lib/status";
import { createClient } from "@/lib/supabase/client";
import type { ExportTaskType } from "@/lib/types";
import { cn } from "@/lib/utils";

type StatusMap = CompetenceStatusMap;
type Filter = "all" | "pending" | "requested";

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)] gap-3 md:grid-cols-[28px_minmax(0,2fr)_160px_110px_minmax(0,1.2fr)]";

const HOW_IT_WORKS = [
  "O robô processa um cliente por vez, com o perfil de navegador e o certificado de cada empresa.",
  "Após o agendamento, o navegador fecha e o Collector consulta a SEFAZ periodicamente até baixar os ZIPs.",
  "Solicitações já existentes para a mesma competência não são repetidas.",
];

function opsForClient(client: PlannerClient, ops: ExportTaskType[]): ExportTaskType[] {
  return EXPORT_OPERATIONS.filter((o) => ops.includes(o.value) && client[o.flag]).map((o) => o.value);
}

function StepLabel({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-(--c-7a7b75)">
      <span className="grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-white">{n}</span>
      {children}
    </div>
  );
}

export function AutomationScheduler({
  clients,
  canForce,
  initialCompetence,
  initialStatuses,
  preselectPending,
}: {
  clients: PlannerClient[];
  canForce: boolean;
  initialCompetence: string;
  initialStatuses: StatusMap;
  preselectPending: boolean;
}) {
  const router = useRouter();
  const active = useMemo(() => clients.filter((c) => c.active), [clients]);
  const [competence, setCompetence] = useState(initialCompetence);
  const [statusCache, setStatusCache] = useState<Record<string, StatusMap>>({ [initialCompetence]: initialStatuses });
  const [operations, setOperations] = useState<ExportTaskType[]>(EXPORT_OPERATIONS.map((o) => o.value));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(preselectPending ? "pending" : "all");
  const [force, setForce] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() =>
    preselectPending
      ? new Set(
          active
            .filter((c) => !blocksNewRequest(initialStatuses[c.id] ?? "none"))
            .filter((c) => c.certificate_status === "valid" || c.certificate_status === "expiring")
            .map((c) => c.id),
        )
      : new Set(),
  );
  const [result, setResult] = useState<BatchSummary | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reloadKey, setReloadKey] = useState(0);

  const statuses = statusCache[competence];
  const loading = !statuses;

  // situação dos clientes na competência escolhida (lida do banco a cada troca)
  useEffect(() => {
    if (statusCache[competence] && reloadKey === 0) return;
    let cancelled = false;
    createClient()
      .from("automation_jobs")
      .select("client_id, competence, status, created_at")
      .eq("competence", competence)
      .not("operations", "cs", "{EFD_CHECK}")
      .order("created_at", { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // sem a situação não dá para saber quem já foi solicitado: tudo segue bloqueado
          toast.error("Não foi possível carregar a situação dos clientes. Recarregue a página.");
          return;
        }
        setStatusCache((prev) => ({ ...prev, [competence]: statusMapFromJobs(data ?? [], competence) }));
      });
    return () => {
      cancelled = true;
    };
    // statusCache fica de fora: só recarrega ao trocar de competência ou após processar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competence, reloadKey]);

  const rows = useMemo(
    () =>
      active.map((c) => {
        const status = statuses?.[c.id] ?? "none";
        const ops = opsForClient(c, operations);
        const certOk = c.certificate_status === "valid" || c.certificate_status === "expiring";
        const blocked = blocksNewRequest(status);
        let lockReason: string | null = null;
        if (loading) lockReason = "carregando…";
        else if (!certOk) lockReason = "sem certificado válido";
        else if (blocked && !force) lockReason = "será ignorado";
        else if (ops.length === 0) lockReason = "operação não habilitada no cadastro";
        const hint =
          lockReason ??
          (blocked ? "reagendar (duplica)" : status === "failed" || status === "cancelled" ? "pode reagendar" : "");
        return { client: c, status, ops, certOk, blocked, locked: lockReason !== null, hint };
      }),
    [active, statuses, operations, force, loading],
  );

  const term = q.trim().toLowerCase();
  const digits = normalizeCNPJ(term).toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "pending" && r.blocked) return false;
    if (filter === "requested" && !r.blocked) return false;
    if (!term) return true;
    const c = r.client;
    return (
      `${c.client_code} ${c.legal_name} ${c.trade_name ?? ""}`.toLowerCase().includes(term) ||
      (digits.length >= 3 && c.cnpj.toLowerCase().includes(digits))
    );
  });

  const selectable = rows.filter((r) => !r.locked);
  const chosen = selectable.filter((r) => selected.has(r.client.id));
  const exportCount = chosen.reduce((acc, r) => acc + r.ops.length, 0);
  const pendingSelectable = selectable.filter((r) => !r.blocked);
  const ignored = force ? 0 : rows.filter((r) => r.blocked).length;
  const visibleSelectable = visible.filter((r) => !r.locked);
  const allOn = visibleSelectable.length > 0 && visibleSelectable.every((r) => selected.has(r.client.id));
  const someOn = visibleSelectable.some((r) => selected.has(r.client.id));
  const canProcess = chosen.length > 0 && operations.length > 0 && !pending;
  const bounds = competenceBounds(competence);
  const maxCompetence = currentCompetence();
  const nextComp = shiftCompetence(competence, 1);
  const prevComp = shiftCompetence(competence, -1);

  function changeCompetence(value: string | null) {
    if (!value || value > maxCompetence) return;
    setCompetence(value);
    setSelected(new Set());
    setResult(null);
    setReloadKey(0);
  }

  function toggle(id: string) {
    setResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setResult(null);
    setSelected((prev) => {
      const next = new Set(prev);
      visibleSelectable.forEach((r) => (allOn ? next.delete(r.client.id) : next.add(r.client.id)));
      return next;
    });
  }

  function submit() {
    const ids = chosen.map((r) => r.client.id);
    startTransition(async () => {
      const res = await createJobs({
        client_ids: ids,
        competence,
        operations,
        force,
        respect_client_flags: true,
      });
      setConfirmOpen(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setResult(res.data ?? null);
      setSelected(new Set());
      setForce(false);
      setReloadKey((k) => k + 1);
      router.refresh();
    });
  }

  const filters: [Filter, string, number][] = [
    ["all", "Todos", rows.length],
    ["pending", "Pendentes", rows.filter((r) => !r.blocked).length],
    ["requested", "Já solicitados", rows.filter((r) => r.blocked).length],
  ];

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-4">
        {/* 1 e 2: competência e operações */}
        <section className="flex flex-wrap items-center gap-x-7 gap-y-4 rounded-xl border bg-card px-[18px] py-4">
          <div className="flex flex-col gap-1.5">
            <StepLabel n={1}>Competência</StepLabel>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Competência anterior"
                onClick={() => changeCompetence(prevComp)}
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
                onClick={() => changeCompetence(nextComp)}
                disabled={!nextComp || nextComp > maxCompetence}
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
          <div className="flex flex-col gap-1.5">
            <StepLabel n={2}>Operações</StepLabel>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_OPERATIONS.map((op) => {
                const on = operations.includes(op.value);
                const Box = on ? SquareCheck : Square;
                return (
                  <button
                    key={op.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setResult(null);
                      setOperations((prev) => (on ? prev.filter((o) => o !== op.value) : [...prev, op.value]));
                    }}
                    className={cn(
                      "flex h-8 items-center gap-[7px] rounded-[7px] border px-3 text-[13px]",
                      on ? "border-(--c-9fd3b5) bg-(--c-eef7f1) text-(--c-17603b)" : "border-input bg-card text-(--c-7a7b75)",
                    )}
                  >
                    <Box className="size-3.5" />
                    {op.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* 3: clientes */}
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
            <div className="mr-1">
              <StepLabel n={3}>Clientes</StepLabel>
            </div>
            <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
              <Search className="size-3.5 text-(--c-9a9b94)" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar cliente, código ou CNPJ"
                aria-label="Buscar cliente, código ou CNPJ"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--c-9a9b94)"
              />
            </div>
            <div className="flex gap-1 rounded-[7px] bg-(--c-f3f3f0) p-0.5" role="tablist">
              {filters.map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "rounded-[5px] px-2.5 py-[5px] text-xs whitespace-nowrap",
                    filter === key ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]" : "text-muted-foreground",
                  )}
                >
                  {label} <span className="font-mono text-(--c-9a9b94)">{count}</span>
                </button>
              ))}
            </div>
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
              onClick={toggleAll}
              disabled={visibleSelectable.length === 0}
              className={cn(
                "box-border grid size-4 place-items-center rounded border-[1.5px] text-white disabled:opacity-40",
                someOn ? "border-primary bg-primary" : "border-(--c-cfcfca) bg-card",
              )}
            >
              {allOn ? <Check className="size-[11px]" /> : someOn ? <Minus className="size-[11px]" /> : null}
            </button>
            <span>Cliente</span>
            <span className="hidden md:block">CNPJ</span>
            <span className="hidden md:block">Certificado</span>
            <span>Status em {formatCompetence(competence)}</span>
          </div>

          <div className="max-h-[62vh] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="p-8 text-center text-[13px] text-(--c-7a7b75)">Nenhum cliente encontrado.</p>
            ) : (
              visible.map((r) => {
                const on = !r.locked && selected.has(r.client.id);
                const c = r.client;
                return (
                  <div
                    key={c.id}
                    role="checkbox"
                    aria-checked={on}
                    aria-disabled={r.locked}
                    tabIndex={r.locked ? -1 : 0}
                    onClick={() => !r.locked && toggle(c.id)}
                    onKeyDown={(e) => {
                      if (!r.locked && (e.key === " " || e.key === "Enter")) {
                        e.preventDefault();
                        toggle(c.id);
                      }
                    }}
                    className={cn(
                      ROW_GRID,
                      "items-center border-b border-(--c-f2f2ef) px-3.5 py-2.5 outline-none last:border-b-0 focus-visible:bg-(--c-f3faf6)",
                      r.locked ? "cursor-not-allowed opacity-[.62]" : "cursor-pointer hover:bg-(--c-fafaf8)",
                      on && "bg-(--c-f3faf6) hover:bg-(--c-f3faf6)",
                    )}
                  >
                    <span
                      className={cn(
                        "box-border grid size-4 place-items-center rounded border-[1.5px] text-white",
                        on ? "border-primary bg-primary" : r.locked ? "border-(--c-cfcfca) bg-(--c-f3f3f0)" : "border-(--c-cfcfca) bg-card",
                      )}
                    >
                      {on ? <Check className="size-[11px]" /> : r.locked ? <Lock className="size-[9px] text-(--c-9a9b94)" /> : null}
                    </span>
                    <div className="flex min-w-0 flex-col gap-px">
                      <span className="truncate text-[13px] font-medium">{c.trade_name || c.legal_name}</span>
                      <span className="font-mono text-[11.5px] text-(--c-7a7b75)">{c.client_code}</span>
                    </div>
                    <span className="hidden font-mono text-[12.5px] text-(--c-4a4b46) md:block">{formatCNPJ(c.cnpj)}</span>
                    <div className="hidden flex-col gap-px md:flex">
                      {r.certOk ? (
                        <span className="flex items-center gap-[5px] text-xs text-(--c-1c7a47)">
                          <ShieldCheck className="size-[13px]" />
                          {c.certificate_status === "expiring" ? "Vencendo" : "Válido"}
                        </span>
                      ) : (
                        <span className="flex items-center gap-[5px] text-xs text-(--c-b42323)">
                          <ShieldAlert className="size-[13px]" />
                          {c.certificate_status === "expired" ? "Vencido" : "Sem certificado"}
                        </span>
                      )}
                      {c.certificate_valid_until ? (
                        <span className="text-[11px] text-(--c-9a9b94)">até {formatDate(c.certificate_valid_until)}</span>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-col items-start gap-0.5">
                      {loading ? (
                        <span className="text-xs text-(--c-9a9b94)">…</span>
                      ) : r.status === "none" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-dashed border-(--c-d9d9d4) px-2 py-px text-xs whitespace-nowrap text-(--c-7a7b75)">
                          <span className="size-1.5 rounded-full bg-(--c-c9c9c4)" />
                          {COMPETENCE_STATUS_LABEL.none}
                        </span>
                      ) : (
                        <ToneBadge tone={COMPETENCE_STATUS_TONE[r.status]}>{COMPETENCE_STATUS_LABEL[r.status]}</ToneBadge>
                      )}
                      {r.hint && !loading ? <span className="text-[11px] text-(--c-9a9b94)">{r.hint}</span> : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* resumo */}
      <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 lg:sticky lg:top-20">
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-col gap-3.5 px-[18px] py-4">
            <p className="text-[14.5px] font-semibold">Resumo do agendamento</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-0.5 rounded-lg bg-(--c-fafaf8) p-2.5">
                <span className="text-[22px] font-semibold tabular-nums">{chosen.length}</span>
                <span className="text-[11.5px] text-(--c-7a7b75)">clientes</span>
              </div>
              <div className="flex flex-col gap-0.5 rounded-lg bg-(--c-fafaf8) p-2.5">
                <span className="text-[22px] font-semibold tabular-nums">{exportCount}</span>
                <span className="text-[11.5px] text-(--c-7a7b75)">exportações</span>
              </div>
            </div>
            <dl className="flex flex-col gap-2 text-[12.5px]">
              <div className="flex justify-between gap-3">
                <dt className="text-(--c-7a7b75)">Competência</dt>
                <dd className="font-mono">{formatCompetence(competence)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-(--c-7a7b75)">Operações</dt>
                <dd className="text-right">
                  {operations.length
                    ? EXPORT_OPERATIONS.filter((o) => operations.includes(o.value)).map((o) => o.label).join(", ")
                    : "Nenhuma"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-(--c-7a7b75)">Tempo estimado</dt>
                <dd className="text-right">{chosen.length ? `~${Math.ceil(chosen.length * 1.5)} min + retorno SEFAZ` : "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-(--c-7a7b75)">Ignorados (já solicitados)</dt>
                <dd>{ignored}</dd>
              </div>
            </dl>
            {pendingSelectable.length > 0 && !pendingSelectable.every((r) => selected.has(r.client.id)) ? (
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setSelected(new Set(pendingSelectable.map((r) => r.client.id)));
                }}
                className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-primary hover:underline"
              >
                <ListChecks className="size-3.5" /> Selecionar pendentes ({pendingSelectable.length})
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canProcess}
              onClick={() => (force ? setConfirmOpen(true) : submit())}
              className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Processar {chosen.length} cliente(s)
            </button>
            {result ? <ResultBox result={result} clients={active} /> : null}
          </div>
          {canForce ? (
            <div
              className={cn(
                "flex items-start gap-2.5 border-t border-(--c-efefeb) px-[18px] py-3",
                force ? "bg-(--c-fdf6e9)" : "bg-(--c-fafaf8)",
              )}
            >
              <button
                type="button"
                role="switch"
                aria-checked={force}
                aria-label="Forçar reagendamento"
                onClick={() => {
                  setForce((v) => !v);
                  setResult(null);
                }}
                className={cn(
                  "relative mt-px h-[18px] w-[30px] shrink-0 rounded-full transition-colors",
                  force ? "bg-(--c-d98e0b)" : "bg-(--c-d4d4cf)",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left]",
                    force ? "left-3.5" : "left-0.5",
                  )}
                />
              </button>
              <div className="flex flex-col gap-0.5">
                <span className="text-[12.5px] font-medium">Forçar reagendamento</span>
                <span className="text-[11.5px] text-(--c-7a7b75)">
                  Libera clientes já solicitados. Pode gerar pedido duplicado no SIAT.
                </span>
              </div>
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
        </section>
      </aside>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forçar reagendamento em {formatCompetence(competence)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {chosen.length} cliente(s) serão agendados de novo, mesmo os que já têm pedido nesta competência. Isso pode
              gerar pedido duplicado no SIAT.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
              disabled={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Play />} Forçar e processar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResultBox({ result, clients }: { result: BatchSummary; clients: PlannerClient[] }) {
  const name = (id: string) => {
    const c = clients.find((x) => x.id === id);
    return c ? c.trade_name || c.legal_name : id;
  };
  const errors = result.results.filter((r) => !r.job_id && !r.duplicate);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-(--c-eef7f1) px-2.5 py-[9px] text-[12.5px] text-(--c-1c5e3c)">
      <div className="flex items-start gap-2">
        <CircleCheck className="mt-px size-3.5 shrink-0" />
        <span className="flex-1">
          {result.created} cliente(s) adicionados à fila.{" "}
          {result.created > 0 ? (
            <Link href="/dashboard" className="font-medium text-primary underline">
              Acompanhar
            </Link>
          ) : null}
        </span>
      </div>
      {result.duplicates > 0 ? (
        <p className="pl-[22px] text-(--c-6b6c66)">{result.duplicates} já estavam agendados e foram ignorados.</p>
      ) : null}
      {errors.map((r) => (
        <p key={r.client_id} className="pl-[22px] text-(--c-b42323)">
          {name(r.client_id)}: {r.message ?? r.error}
        </p>
      ))}
    </div>
  );
}
