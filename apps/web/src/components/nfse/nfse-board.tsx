"use client";

import { BriefcaseBusiness, CircleCheck, ListChecks, Loader2, Lock, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { requestNfseFetch, type NfseFetchSummary } from "@/app/actions/nfse";
import { ListEmptyText } from "@/components/data-list";
import { CheckAll, CheckBox, LockedGroup, type LockedRow, StatusTabs, StickyBar } from "@/components/list-extras";
import { ToneBadge } from "@/components/status-badge";
import { normalizeCNPJ } from "@/lib/cnpj";
import { formatDateTime } from "@/lib/format";
import {
  latestNfseJob,
  NFSE_SEVERITY,
  NFSE_STATE_LABEL,
  NFSE_STATE_TONE,
  nfseHint,
  nfseRowState,
  type NfseCursor,
  type NfseJob,
  type NfseRowState,
} from "@/lib/nfse";
import { createClient, subscribeWithAuth } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export interface NfseClient {
  id: string;
  client_code: string;
  name: string;
  legal_name: string;
  cnpj: string;
  certificate_ok: boolean;
}

type Tab = "all" | NfseRowState;

const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_minmax(0,auto)] gap-3 md:grid-cols-[28px_minmax(150px,1.3fr)_minmax(200px,1.6fr)_minmax(130px,0.8fr)]";

export function NfseBoard({
  clients,
  cursors,
  jobs,
  canRun,
}: {
  clients: NfseClient[];
  cursors: NfseCursor[];
  jobs: NfseJob[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showLocked, setShowLocked] = useState(false);
  const [result, setResult] = useState<NfseFetchSummary | null>(null);
  const [pending, startTransition] = useTransition();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // quando o robô avança ou termina uma busca de NFS-e, recarrega a lista
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("nfse")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "automation_jobs" }, (payload) => {
        const row = payload.new as { operations?: string[] };
        if (!row.operations?.includes("NFSE_FETCH")) return;
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
    const cursorBy = new Map(cursors.map((c) => [c.client_id, c]));
    const jobsBy = new Map<string, NfseJob[]>();
    for (const j of jobs) jobsBy.set(j.client_id, [...(jobsBy.get(j.client_id) ?? []), j]);
    return clients
      .map((c) => {
        const cursor = cursorBy.get(c.id);
        const lastJob = latestNfseJob(jobsBy.get(c.id) ?? []);
        const state = nfseRowState(cursor, lastJob);
        return { client: c, cursor, lastJob, state, hint: nfseHint(state, lastJob) };
      })
      .sort(
        (a, b) =>
          NFSE_SEVERITY.indexOf(a.state) - NFSE_SEVERITY.indexOf(b.state) ||
          a.client.name.localeCompare(b.client.name, "pt-BR", { sensitivity: "base" }),
      );
  }, [clients, cursors, jobs]);

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
  // sem certificado e nunca buscado: vai para o grupo dos bloqueados no fim da lista
  const hidden = (r: (typeof rows)[number]) => !r.client.certificate_ok && r.state === "never";
  const visible = inTab.filter((r) => !hidden(r) && matches(r));
  const locked = inTab.filter((r) => hidden(r) && matches(r));
  const lockedOf = (r: (typeof rows)[number]) =>
    !canRun ? "sem permissão" : !r.client.certificate_ok ? "sem certificado válido" : r.state === "fetching" ? "já na fila" : null;
  const selectable = visible.filter((r) => !lockedOf(r));
  const chosen = rows.filter((r) => !lockedOf(r) && selected.has(r.client.id));
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.client.id));
  const someOn = selectable.some((r) => selected.has(r.client.id));
  const count = (s: NfseRowState) => rows.filter((r) => r.state === s).length;
  const ready = rows.filter((r) => !lockedOf(r));

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
      const res = await requestNfseFetch({ client_ids: ids });
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
        <Link href="/downloads?type=nfse" className="text-[12.5px] font-medium text-primary hover:underline">
          Ver as notas em Downloads
        </Link>
      </div>
      <div className="border-b border-(--c-efefeb) px-3.5 py-2">
        <StatusTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "all", label: "Todos", count: rows.length },
            { key: "error", label: "Com erro", count: count("error"), color: "#dc3b3b" },
            { key: "never", label: "Nunca buscado", count: count("never"), color: "#d4d4cf" },
            { key: "fetching", label: "Buscando", count: count("fetching"), color: "#3b82c4" },
            { key: "done", label: "Em dia", count: count("done"), color: "#2ea062" },
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
        <span className="hidden md:block">Última busca</span>
      </div>
      {visible.length === 0 && locked.length === 0 ? (
        <ListEmptyText>Nenhum cliente encontrado.</ListEmptyText>
      ) : (
        visible.map((r) => {
          const c = r.client;
          const lock = lockedOf(r);
          const on = !lock && selected.has(c.id);
          return (
            <div key={c.id} className={cn(ROW_GRID, "items-center border-b border-(--c-f2f2ef) px-3.5 py-2.5", on && "bg-(--c-f3faf6)")}>
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
              <Link href={`/clients/${c.id}`} className="flex min-w-0 flex-col gap-px text-foreground hover:no-underline">
                <span className="truncate text-[13px] font-medium" title={c.name}>
                  {c.name}
                </span>
                <span className="truncate font-mono text-[11.5px] text-(--c-6b6c66)">
                  {c.client_code}
                  {!c.certificate_ok ? <span className="font-sans"> · sem certificado válido</span> : null}
                </span>
              </Link>
              <div className="flex min-w-0 flex-col items-end gap-0.5 md:items-start">
                <ToneBadge tone={NFSE_STATE_TONE[r.state]}>
                  {r.state === "fetching" ? <Loader2 className="size-3 animate-spin" /> : null}
                  {NFSE_STATE_LABEL[r.state]}
                </ToneBadge>
                {r.hint ? (
                  <span
                    className={cn(
                      "line-clamp-2 max-w-full text-[11.5px] leading-[1.3] text-pretty",
                      r.state === "error" ? "font-medium text-(--c-b42323)" : "text-(--c-6b6c66)",
                    )}
                    title={r.hint}
                  >
                    {r.lastJob && (r.state === "error" || r.state === "done") ? (
                      <Link href={`/history/${r.lastJob.id}`} className="text-inherit hover:underline">
                        {r.hint}
                      </Link>
                    ) : (
                      r.hint
                    )}
                  </span>
                ) : null}
              </div>
              <div className="hidden min-w-0 flex-col gap-px md:flex">
                {r.cursor?.fetched_at ? (
                  <>
                    <span className="text-xs whitespace-nowrap tabular-nums">{formatDateTime(r.cursor.fetched_at)}</span>
                    <span className="font-mono text-[11px] text-(--c-6b6c66)">NSU {r.cursor.last_nsu}</span>
                  </>
                ) : (
                  <span className="text-xs text-(--c-c9c9c4)">—</span>
                )}
              </div>
            </div>
          );
        })
      )}
      <LockedGroup
        title="Sem certificado válido"
        rows={lockedRows}
        open={showLocked}
        onToggle={() => setShowLocked((v) => !v)}
      />
      {result ? (
        <StickyBar success>
          <CircleCheck className="size-4 shrink-0 text-(--c-1c7a47)" />
          <span className="min-w-0 flex-1 text-[13px] text-(--c-1c5e3c)">
            <b className="font-semibold">{result.created} busca(s) na fila.</b>
            {result.skipped ? ` ${result.skipped} já estava(m) na fila.` : ""} O resultado aparece aqui sozinho.
          </span>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="flex h-8 items-center rounded-[7px] border border-(--c-d3ebdc) bg-card px-3 text-[12.5px] text-primary hover:bg-(--c-eef7f1)"
          >
            Buscar mais
          </button>
        </StickyBar>
      ) : (
        <StickyBar>
          {!canRun ? (
            <span className="text-[12.5px] text-(--c-6b6c66)">Seu perfil só visualiza os resultados.</span>
          ) : (
            <>
              {ready.length > 0 && !ready.every((r) => selected.has(r.client.id)) ? (
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setSelected(new Set(ready.map((r) => r.client.id)));
                  }}
                  className="flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"
                >
                  <ListChecks className="size-3.5" /> Selecionar todos com certificado
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
                {pending ? <Loader2 className="size-4 animate-spin" /> : <BriefcaseBusiness className="size-4" />}
                Buscar NFS-e
              </button>
            </>
          )}
        </StickyBar>
      )}
    </section>
  );
}
