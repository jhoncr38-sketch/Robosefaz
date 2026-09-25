"use client";

import { Loader2, Play, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { createJobs, type BatchSummary } from "@/app/actions/automation";
import { CompetenceSelect } from "@/components/automation/competence-select";
import type { PlannerClient } from "@/components/automation/planner-types";
import { CertificateStatusBadge } from "@/components/status-badge";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCNPJ } from "@/lib/cnpj";
import { competenceBounds, formatCompetence, previousCompetence } from "@/lib/competence";
import { EXPORT_OPERATIONS } from "@/lib/status";
import type { ExportTaskType } from "@/lib/types";

interface Filters {
  active: boolean;
  validCertificate: boolean;
  withNfce: boolean;
  withNfe: boolean;
  search: string;
}

function opsForClient(client: PlannerClient, ops: ExportTaskType[]): ExportTaskType[] {
  return EXPORT_OPERATIONS.filter((o) => ops.includes(o.value) && client[o.flag]).map((o) => o.value);
}

export function AutomationPlanner({
  clients,
  canForce,
  onDone,
  compact = false,
}: {
  clients: PlannerClient[];
  canForce: boolean;
  onDone?: (summary: BatchSummary) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const [competence, setCompetence] = useState(previousCompetence());
  const [operations, setOperations] = useState<ExportTaskType[]>(["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"]);
  const [filters, setFilters] = useState<Filters>({
    active: true,
    validCertificate: true,
    withNfce: false,
    withNfe: false,
    search: "",
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [lastSummary, setLastSummary] = useState<BatchSummary | null>(null);

  const visible = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return clients.filter((c) => {
      if (filters.active && !c.active) return false;
      if (filters.validCertificate && !(c.certificate_status === "valid" || c.certificate_status === "expiring")) return false;
      if (filters.withNfce && !c.uses_nfce) return false;
      if (filters.withNfe && !(c.uses_nfe_issued || c.uses_nfe_received)) return false;
      if (q) {
        const hay = `${c.client_code} ${c.legal_name} ${c.trade_name ?? ""} ${c.cnpj}`.toLowerCase();
        if (!hay.includes(q.replace(/[./-]/g, "")) && !hay.includes(q)) return false;
      }
      return true;
    });
  }, [clients, filters]);

  const selectedClients = clients.filter((c) => selected.has(c.id));
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));
  const plannedTasks = selectedClients.reduce((acc, c) => acc + opsForClient(c, operations).length, 0);
  const bounds = competenceBounds(competence);

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      visible.forEach((c) => (on ? next.add(c.id) : next.delete(c.id)));
      return next;
    });
  }

  function toggleOp(op: ExportTaskType, on: boolean) {
    setOperations((prev) => (on ? [...new Set([...prev, op])] : prev.filter((o) => o !== op)));
  }

  function submit() {
    startTransition(async () => {
      const res = await createJobs({
        client_ids: [...selected],
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
      toast.success(res.message);
      if (res.data) {
        setLastSummary(res.data);
        onDone?.(res.data);
      }
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 rounded-xl border bg-card p-4 md:grid-cols-[auto_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="competence">Competência</Label>
          <CompetenceSelect id="competence" value={competence} onChange={setCompetence} />
        </div>
        <div className="space-y-2">
          <Label>Operações</Label>
          <div className="flex flex-wrap gap-4">
            {EXPORT_OPERATIONS.map((op) => (
              <label key={op.value} className="flex items-center gap-2 text-sm">
                <Checkbox checked={operations.includes(op.value)} onCheckedChange={(v) => toggleOp(op.value, v === true)} />
                {op.label}
              </label>
            ))}
          </div>
          {canForce ? (
            <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
              <Switch checked={force} onCheckedChange={setForce} />
              Forçar novo agendamento mesmo se já existir (somente admin)
            </label>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar cliente, código ou CNPJ"
            className="pl-8"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          />
        </div>
        {(
          [
            ["active", "Ativos"],
            ["validCertificate", "Certificado válido"],
            ["withNfce", "Com NFC-e"],
            ["withNfe", "Com NF-e"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={filters[key]}
              onCheckedChange={(v) => setFilters((f) => ({ ...f, [key]: v === true }))}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className={compact ? "max-h-[45vh] overflow-y-auto" : "max-h-[60vh] overflow-y-auto"}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Selecionar todos"
                    checked={allVisibleSelected ? true : visible.some((c) => selected.has(c.id)) ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAll(v === true)}
                  />
                </TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Certificado</TableHead>
                <TableHead>Operações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhum cliente com os filtros atuais.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((c) => {
                  const ops = opsForClient(c, operations);
                  return (
                    <TableRow key={c.id} data-state={selected.has(c.id) ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Selecionar ${c.legal_name}`}
                          checked={selected.has(c.id)}
                          onCheckedChange={(v) => toggle(c.id, v === true)}
                        />
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{c.trade_name || c.legal_name}</p>
                        <p className="text-xs text-muted-foreground">{c.client_code}</p>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{formatCNPJ(c.cnpj)}</TableCell>
                      <TableCell>
                        {c.certificate_status ? (
                          <CertificateStatusBadge status={c.certificate_status} />
                        ) : (
                          <span className="text-xs text-red-600">Sem certificado</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ops.length
                          ? EXPORT_OPERATIONS.filter((o) => ops.includes(o.value)).map((o) => o.label).join(", ")
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{selected.size}</span> cliente(s) selecionado(s) ·{" "}
          <span className="font-medium text-foreground">{plannedTasks}</span> exportação(ões) em {formatCompetence(competence)}
        </p>
        <Button
          size="lg"
          disabled={selected.size === 0 || operations.length === 0 || pending}
          onClick={() => setConfirmOpen(true)}
        >
          <Play /> Processar selecionados
        </Button>
      </div>

      {lastSummary ? (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="font-medium">Resultado do último envio</p>
          <p className="text-muted-foreground">
            {lastSummary.created} job(s) criado(s) · {lastSummary.duplicates} já agendado(s) · {lastSummary.failed} com erro
          </p>
          {lastSummary.results
            .filter((r) => r.error)
            .map((r) => (
              <p key={r.client_id} className="text-xs text-red-600">
                {clients.find((c) => c.id === r.client_id)?.legal_name ?? r.client_id}: {r.message ?? r.error}
              </p>
            ))}
        </div>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar processamento de {formatCompetence(competence)}</AlertDialogTitle>
            <AlertDialogDescription>
              Período {bounds?.start} a {bounds?.end}. Será criada uma tarefa por cliente, processada em sequência pelo robô.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border p-3 text-sm">
            {selectedClients.map((c) => {
              const ops = opsForClient(c, operations);
              return (
                <div key={c.id} className="flex justify-between gap-3">
                  <span className="truncate">{c.trade_name || c.legal_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {ops.length ? EXPORT_OPERATIONS.filter((o) => ops.includes(o.value)).map((o) => o.label).join(" · ") : "nenhuma operação habilitada"}
                  </span>
                </div>
              );
            })}
          </div>
          {force ? (
            <p className="text-xs font-medium text-orange-700">Atenção: novos agendamentos serão forçados mesmo que já existam.</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
              disabled={pending}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Play />} Confirmar e criar tarefas
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
