"use client";

import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  ListChecks,
  Loader2,
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
import { CheckAll, CheckBox, LockedGroup, type LockedRow, MiniSwitch, StickyBar } from "@/components/list-extras";
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
import { currentCompetence, formatCompetence, shiftCompetence } from "@/lib/competence";
import {
  blocksNewRequest,
  COMPETENCE_STATUS_LABEL,
  COMPETENCE_STATUS_TONE,
  plannerStatusMap,
  type CompetenceStatusMap,
} from "@/lib/competence-status";
import { formatDate } from "@/lib/format";
import { EXPORT_OPERATIONS, withCanceled } from "@/lib/status";
import { createClient } from "@/lib/supabase/client";
import type { RegularExportTaskType } from "@/lib/types";
import { cn } from "@/lib/utils";

type StatusMap = CompetenceStatusMap;
type Filter = "all" | "pending" | "requested";

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)] gap-3 md:grid-cols-[28px_minmax(0,2fr)_150px_110px_minmax(0,1.1fr)]";

const OP_TAG: Record<RegularExportTaskType, string> = {
  NFCE_EXPORT: "NFC-e",
  NFE_ISSUED_EXPORT: "Emit.",
  NFE_RECEIVED_EXPORT: "Receb.",
};

const FORCE_HELP =
  "Libera clientes já solicitados: o robô exclui no SIAT o agendamento anterior desta competência e faz um novo.";

function opsForClient(client: PlannerClient, ops: RegularExportTaskType[]): RegularExportTaskType[] {
  return EXPORT_OPERATIONS.filter((o) => ops.includes(o.value) && client[o.flag]).map((o) => o.value);
}

/** Bloqueio de cada cliente e o atalho para resolver. */
type LockReason = "cert" | "ops" | "requested" | "siat";

const LOCK_TEXT: Record<LockReason, string> = {
  cert: "sem certificado válido",
  ops: "operação não habilitada no cadastro",
  requested: "já solicitado nesta competência",
  siat: "sem inscrição estadual: só NFS-e (ligue o botão NFS-e ou use a tela NFS-e Nacional)",
};

export function AutomationScheduler({
  clients,
  canForce,
  initialCompetence,
  initialStatuses,
}: {
  clients: PlannerClient[];
  canForce: boolean;
  initialCompetence: string;
  initialStatuses: StatusMap;
}) {
  const router = useRouter();
  const active = useMemo(() => clients.filter((c) => c.active), [clients]);
  // empresas só de serviço (sem SIAT): nesta tela só entram na busca de NFS-e
  const nfseOnly = useMemo(() => new Set(clients.filter((c) => !c.uses_siat).map((c) => c.id)), [clients]);
  const [competence, setCompetence] = useState(initialCompetence);
  const [statusCache, setStatusCache] = useState<Record<string, StatusMap>>({ [initialCompetence]: initialStatuses });
  const [operations, setOperations] = useState<RegularExportTaskType[]>(EXPORT_OPERATIONS.map((o) => o.value));
  // "Canceladas": um pedido a mais de cada tipo marcado, com Status "Canceladas" (ZIP próprio)
  const [canceled, setCanceled] = useState(false);
  // NFS-e Nacional: pede também a busca das notas de serviço de quem entrar na fila
  const [nfse, setNfse] = useState(true);
  const [q, setQ] = useState("");
  // abre em "Pendentes", com os pendentes selecionados
  const [filter, setFilter] = useState<Filter>("pending");
  const [force, setForce] = useState(false);
  // seleção escolhida pelo usuário em cada competência (sem escolha: os pendentes)
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [processedResult, setProcessedResult] = useState<BatchSummary | null>(null);
  const [showLocked, setShowLocked] = useState(false);
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
      .select("client_id, competence, status, created_at, operations")
      .eq("competence", competence)
      .not("operations", "cs", "{EFD_CHECK}")
      .not("operations", "cs", "{MALHA_CHECK}")
      .order("created_at", { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // sem a situação não dá para saber quem já foi solicitado: tudo segue bloqueado
          toast.error("Não foi possível carregar a situação dos clientes. Recarregue a página.");
          return;
        }
        // pedido só de canceladas não conta como "mês solicitado"; na empresa só de serviço vale a busca de NFS-e
        setStatusCache((prev) => ({ ...prev, [competence]: plannerStatusMap(data ?? [], competence, nfseOnly) }));
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
        const siat = c.uses_siat;
        const ops = siat ? opsForClient(c, operations) : [];
        const certOk = c.certificate_status === "valid" || c.certificate_status === "expiring";
        const blocked = blocksNewRequest(status);
        let lock: LockReason | null = null;
        if (!certOk) lock = "cert";
        // empresa só de serviço: entra só com o botão NFS-e ligado; a busca já pedida no mês não se repete
        else if (!siat) lock = !nfse ? "siat" : blocked ? "requested" : null;
        // já solicitado: com "Canceladas" ligado, pede só as canceladas (os pedidos repetidos são ignorados)
        else if (blocked && !force && !canceled) lock = "requested";
        else if (ops.length === 0) lock = "ops";
        const hint = !siat
          ? ""
          : blocked && !force
            ? "só as canceladas"
            : blocked
              ? "reagendar (duplica)"
              : status === "failed" || status === "cancelled"
                ? "pode reagendar"
                : "";
        return { client: c, status, ops, certOk, blocked, lock, hint, siat };
      }),
    [active, statuses, operations, force, canceled, nfse],
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

  const selectable = loading ? [] : rows.filter((r) => !r.lock);
  const pendingSelectable = selectable.filter((r) => !r.blocked);
  const selected = picked[competence] ?? new Set(pendingSelectable.map((r) => r.client.id));
  const chosen = selectable.filter((r) => selected.has(r.client.id));
  // com "Canceladas", cada tipo vira dois pedidos; quem já foi solicitado pede só as canceladas
  const exportCount = chosen.reduce((acc, r) => acc + r.ops.length * (canceled && !(r.blocked && !force) ? 2 : 1), 0);
  const visibleOpen = visible.filter((r) => !r.lock);
  const visibleLocked = visible.filter((r) => r.lock);
  const allOn = visibleOpen.length > 0 && visibleOpen.every((r) => selected.has(r.client.id));
  const someOn = visibleOpen.some((r) => selected.has(r.client.id));
  const chosenSiat = chosen.filter((r) => r.siat);
  const chosenNfseOnly = chosen.filter((r) => !r.siat);
  const canProcess = !loading && chosen.length > 0 && (operations.length > 0 || chosenSiat.length === 0) && !pending;
  const maxCompetence = currentCompetence();
  const nextComp = shiftCompetence(competence, 1);
  const prevComp = shiftCompetence(competence, -1);

  function changeCompetence(value: string | null) {
    if (!value || value > maxCompetence) return;
    setCompetence(value);
    setProcessedResult(null);
    setReloadKey(0);
  }

  function setSelected(update: (prev: Set<string>) => Set<string>) {
    setProcessedResult(null);
    setPicked((prev) => ({ ...prev, [competence]: update(new Set(selected)) }));
  }

  function toggle(id: string) {
    setSelected((s) => {
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }

  function toggleAll() {
    setSelected((s) => {
      visibleOpen.forEach((r) => (allOn ? s.delete(r.client.id) : s.add(r.client.id)));
      return s;
    });
  }

  function submit() {
    startTransition(async () => {
      const res = await createJobs({
        client_ids: chosenSiat.map((r) => r.client.id),
        nfse_client_ids: chosenNfseOnly.map((r) => r.client.id),
        competence,
        operations: withCanceled(operations, canceled),
        force,
        respect_client_flags: true,
        nfse,
      });
      setConfirmOpen(false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const summary = res.data ?? null;
      setProcessedResult(summary);
      // os agendados passam a aparecer como "Na fila" (o banco confirma em seguida)
      const queued = [...(summary?.results ?? []).filter((r) => r.job_id).map((r) => r.client_id), ...(summary?.nfseQueued ?? [])];
      setStatusCache((prev) => ({
        ...prev,
        [competence]: { ...prev[competence], ...Object.fromEntries(queued.map((id) => [id, "queued" as const])) },
      }));
      setPicked((prev) => ({ ...prev, [competence]: new Set() }));
      setForce(false);
      setReloadKey((k) => k + 1);
      router.refresh();
    });
  }

  function scheduleMore() {
    setProcessedResult(null);
    setPicked((prev) => {
      const next = { ...prev };
      delete next[competence];
      return next;
    });
  }

  const filters: [Filter, string, number][] = [
    ["all", "Todos", rows.length],
    ["pending", "Pendentes", rows.filter((r) => !r.blocked).length],
    ["requested", "Já solicitados", rows.filter((r) => r.blocked).length],
  ];

  const lockedRows: LockedRow[] = visibleLocked.map((r) => ({
    id: r.client.id,
    name: r.client.trade_name || r.client.legal_name,
    code: r.client.client_code,
    reason: LOCK_TEXT[r.lock!],
    danger: r.lock === "cert",
    action:
      r.lock === "cert"
        ? { label: "Renovar certificado", href: `/clients/${r.client.id}` }
        : r.lock === "ops"
          ? { label: "Ver cadastro", href: `/clients/${r.client.id}` }
          : undefined,
  }));

  return (
    <div className="flex flex-col gap-4">
      {/* topo numa linha: competência e operações */}
      <section className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-xl border bg-card px-4 py-3 shadow-card">
        <span className="text-xs text-(--c-6b6c66)">Competência</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Competência anterior"
            onClick={() => changeCompetence(prevComp)}
            className="grid h-[30px] w-7 place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef)"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <div className="flex h-[30px] min-w-[76px] items-center justify-center rounded-[7px] border border-input px-2.5 font-mono text-sm font-medium">
            {formatCompetence(competence)}
          </div>
          <button
            type="button"
            aria-label="Próxima competência"
            onClick={() => changeCompetence(nextComp)}
            disabled={!nextComp || nextComp > maxCompetence}
            className="grid h-[30px] w-7 place-items-center rounded-[7px] border border-input hover:bg-(--c-f2f3ef) disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
        <span className="hidden h-[22px] w-px bg-(--c-efefeb) sm:block" />
        <span className="text-xs text-(--c-6b6c66)">Operações</span>
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
                  setProcessedResult(null);
                  setOperations((prev) => (on ? prev.filter((o) => o !== op.value) : [...prev, op.value]));
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px]",
                  on ? "border-(--c-9fd3b5) bg-(--c-eef7f1) text-(--c-17603b)" : "border-input bg-card text-(--c-6b6c66)",
                )}
              >
                <Box className="size-[13px]" />
                {op.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={canceled}
            title="Mais um pedido de cada tipo marcado, só com as notas canceladas (ZIP separado)"
            onClick={() => {
              setProcessedResult(null);
              setCanceled((v) => !v);
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px]",
              canceled ? "border-(--c-b42323)/30 bg-(--c-fdecec) text-(--c-b42323)" : "border-input bg-card text-(--c-6b6c66)",
            )}
          >
            {canceled ? <SquareCheck className="size-[13px]" /> : <Square className="size-[13px]" />}
            Canceladas
          </button>
          <button
            type="button"
            aria-pressed={nfse}
            title="Busca também as notas de serviço (NFS-e Nacional) dos clientes que entrarem na fila: prestadas e tomadas, sem passar pelo SIAT"
            onClick={() => {
              setProcessedResult(null);
              setNfse((v) => !v);
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px]",
              nfse ? "border-(--c-9fd3b5) bg-(--c-eef7f1) text-(--c-17603b)" : "border-input bg-card text-(--c-6b6c66)",
            )}
          >
            {nfse ? <SquareCheck className="size-[13px]" /> : <Square className="size-[13px]" />}
            NFS-e
          </button>
        </div>
      </section>

      {/* clientes: a lista ocupa a largura toda; o rodapé fica grudado embaixo */}
      <section className="overflow-clip rounded-xl border bg-card shadow-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
          <div className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring">
            <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar cliente, código ou CNPJ"
              aria-label="Buscar cliente, código ou CNPJ"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ellipsis outline-none placeholder:text-(--c-6b6c66)"
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
                {label} <span className="font-mono text-(--c-6b6c66)">{count}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          className={cn(
            ROW_GRID,
            "items-center border-b border-(--c-efefeb) bg-(--c-fafaf8) px-3.5 py-[9px] text-[11.5px] tracking-[0.04em] text-(--c-6b6c66) uppercase",
          )}
        >
          <CheckAll all={allOn} some={someOn} disabled={visibleOpen.length === 0 || loading} onToggle={toggleAll} />
          <span>Cliente</span>
          <span className="hidden md:block">Operações</span>
          <span className="hidden md:block">Certificado</span>
          <span>Situação</span>
        </div>

        {loading ? (
          <p className="flex items-center justify-center gap-2 p-8 text-[13px] text-(--c-6b6c66)">
            <Loader2 className="size-3.5 animate-spin" /> Carregando a situação dos clientes…
          </p>
        ) : visibleOpen.length === 0 && visibleLocked.length === 0 ? (
          <p className="p-8 text-center text-[13px] text-(--c-6b6c66)">Nenhum cliente encontrado.</p>
        ) : (
          visibleOpen.map((r) => {
            const on = selected.has(r.client.id);
            const c = r.client;
            return (
              <div
                key={c.id}
                role="checkbox"
                aria-checked={on}
                tabIndex={0}
                onClick={() => toggle(c.id)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    toggle(c.id);
                  }
                }}
                className={cn(
                  ROW_GRID,
                  "cursor-pointer items-center border-b border-(--c-f2f2ef) px-3.5 py-2.5 outline-none hover:bg-(--c-fafaf8) focus-visible:bg-(--c-f3faf6)",
                  on && "bg-(--c-f3faf6) hover:bg-(--c-f3faf6)",
                )}
              >
                <CheckBox on={on} />
                <div className="flex min-w-0 flex-col gap-px">
                  <span className="truncate text-[13px] font-medium">{c.trade_name || c.legal_name}</span>
                  <span className="truncate font-mono text-[11.5px] text-(--c-6b6c66)">
                    {c.client_code} · {formatCNPJ(c.cnpj)}
                  </span>
                </div>
                <div className="hidden flex-wrap gap-1 md:flex">
                  {!r.siat ? (
                    <span
                      title="Empresa sem inscrição estadual: não usa o SIAT; só a busca de NFS-e Nacional"
                      className="rounded bg-(--c-eef7f1) px-[5px] py-px font-mono text-[10.5px] whitespace-nowrap text-(--c-17603b)"
                    >
                      só NFS-e
                    </span>
                  ) : null}
                  {(r.siat ? EXPORT_OPERATIONS : []).map((op) => {
                    const enabled = c[op.flag];
                    const onTop = operations.includes(op.value);
                    return (
                      <span
                        key={op.value}
                        title={!enabled ? `${op.label}: não habilitada no cadastro` : !onTop ? `${op.label}: desmarcada no topo` : op.label}
                        className={cn(
                          "rounded px-[5px] py-px font-mono text-[10.5px] whitespace-nowrap",
                          enabled && onTop ? "bg-(--c-f2f2ef) text-(--c-4a4b46)" : "text-(--c-c9c9c4)",
                          !enabled && "line-through",
                        )}
                      >
                        {OP_TAG[op.value]}
                      </span>
                    );
                  })}
                </div>
                <span
                  className={cn(
                    "hidden items-center gap-[5px] text-xs md:flex",
                    c.certificate_status === "expiring" ? "text-(--c-b45309)" : "text-(--c-1c7a47)",
                  )}
                  title={c.certificate_valid_until ? `até ${formatDate(c.certificate_valid_until)}` : undefined}
                >
                  {r.certOk ? (
                    <ShieldCheck className={cn("size-[13px]", c.certificate_status === "expiring" && "text-(--c-d97706)")} />
                  ) : (
                    <ShieldAlert className="size-[13px]" />
                  )}
                  {c.certificate_status === "expiring" ? "Vencendo" : "Válido"}
                </span>
                <div className="flex min-w-0 flex-col items-start gap-0.5">
                  {r.status === "none" ? (
                    <span className="text-xs text-(--c-c9c9c4)">—</span>
                  ) : (
                    <ToneBadge tone={COMPETENCE_STATUS_TONE[r.status]}>{COMPETENCE_STATUS_LABEL[r.status]}</ToneBadge>
                  )}
                  {r.hint ? <span className="text-[11.5px] text-(--c-6b6c66)">{r.hint}</span> : null}
                </div>
              </div>
            );
          })
        )}

        {!loading ? (
          <LockedGroup
            title={`${lockedRows.length} ${lockedRows.length === 1 ? "não pode ser agendado agora" : "não podem ser agendados agora"}`}
            rows={lockedRows}
            open={showLocked}
            onToggle={() => setShowLocked((v) => !v)}
          />
        ) : null}

        {processedResult ? (
          <StickyBar success>
            <CircleCheck className="size-4 shrink-0 text-(--c-1c7a47)" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px] text-(--c-1c5e3c)">
              <span>
                <b className="font-semibold">
                  {processedResult.created || processedResult.nfseQueued?.length || 0} cliente(s) adicionados à fila.
                </b>{" "}
                O robô começa assim que estiver livre.
              </span>
              {processedResult.nfse ? (
                <span className="text-xs text-(--c-6b6c66)">
                  Busca de NFS-e Nacional pedida para {processedResult.nfse} cliente(s).
                </span>
              ) : null}
              {processedResult.duplicates > 0 ? (
                <span className="text-xs text-(--c-6b6c66)">
                  {processedResult.duplicates} já estavam agendados e foram ignorados.
                </span>
              ) : null}
              {processedResult.results
                .filter((r) => !r.job_id && !r.duplicate)
                .map((r) => (
                  <span key={r.client_id} className="text-xs text-(--c-b42323)">
                    {active.find((c) => c.id === r.client_id)?.trade_name ||
                      active.find((c) => c.id === r.client_id)?.legal_name ||
                      r.client_id}
                    : {r.message ?? r.error}
                  </span>
                ))}
            </div>
            <Link href="/queue" className="text-[13px] font-medium whitespace-nowrap text-primary">
              Acompanhar na Fila →
            </Link>
            <button
              type="button"
              onClick={scheduleMore}
              className="flex h-8 items-center rounded-[7px] border border-(--c-d3ebdc) bg-card px-3 text-[12.5px] text-primary hover:bg-(--c-eef7f1)"
            >
              Agendar mais
            </button>
          </StickyBar>
        ) : (
          <StickyBar>
            {canForce ? (
              <label className="flex items-center gap-2" title={FORCE_HELP}>
                <MiniSwitch
                  on={force}
                  label="Forçar reagendamento"
                  onChange={(v) => {
                    setForce(v);
                    setProcessedResult(null);
                  }}
                />
                <span className="text-[12.5px] text-(--c-3d3e3a)">Forçar reagendamento</span>
              </label>
            ) : null}
            <span className="flex-1" />
            {pendingSelectable.length > 0 && !pendingSelectable.every((r) => selected.has(r.client.id)) ? (
              <button
                type="button"
                onClick={() => setSelected(() => new Set(pendingSelectable.map((r) => r.client.id)))}
                className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
              >
                <ListChecks className="size-3.5" /> Selecionar pendentes ({pendingSelectable.length})
              </button>
            ) : null}
            <span className="text-[13px] whitespace-nowrap text-(--c-4a4b46)">
              <b className="font-semibold text-foreground">{chosen.length}</b> clientes ·{" "}
              <b className="font-semibold text-foreground">{exportCount}</b> exportações
              {chosenNfseOnly.length ? ` · ${chosenNfseOnly.length} só NFS-e` : ""}
              {chosenSiat.length ? ` · ~${Math.ceil(chosenSiat.length * 1.5)} min + retorno SEFAZ` : ""}
            </span>
            <button
              type="button"
              disabled={!canProcess}
              onClick={() => (force ? setConfirmOpen(true) : submit())}
              className="flex h-[38px] items-center gap-2 rounded-lg bg-primary px-4 text-[13.5px] font-medium whitespace-nowrap text-white hover:bg-(--c-196640) disabled:cursor-not-allowed disabled:bg-(--c-a9cdb8)"
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Processar {chosen.length} cliente(s)
            </button>
          </StickyBar>
        )}
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forçar reagendamento em {formatCompetence(competence)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {chosen.length} cliente(s) serão agendados de novo, mesmo os que já têm pedido nesta competência. Quando o
              SIAT disser que o agendamento já existe, o robô exclui esse agendamento no SIAT e pede um novo. Os arquivos
              já baixados continuam nas pastas.
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
