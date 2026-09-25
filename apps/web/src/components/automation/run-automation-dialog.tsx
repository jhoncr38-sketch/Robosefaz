"use client";

import { Loader2, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createClientJob } from "@/app/actions/automation";
import { CompetenceSelect } from "@/components/automation/competence-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { previousCompetence } from "@/lib/competence";
import { EXPORT_OPERATIONS } from "@/lib/status";
import type { Client, ExportTaskType } from "@/lib/types";

export function RunAutomationDialog({ client, canForce, disabled }: { client: Client; canForce: boolean; disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [competence, setCompetence] = useState(previousCompetence());
  const [ops, setOps] = useState<ExportTaskType[]>(
    EXPORT_OPERATIONS.filter((o) => client[o.flag]).map((o) => o.value),
  );
  const [force, setForce] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(forceRun = force) {
    startTransition(async () => {
      const res = await createClientJob({ clientId: client.id, competence, operations: ops, force: forceRun });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.data?.duplicate) {
        setDuplicate(true);
        toast.warning("Exportação já agendada.");
        return;
      }
      toast.success(res.message);
      setOpen(false);
      setDuplicate(false);
      router.push("/queue");
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setDuplicate(false); }}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>
          <Play /> Executar automação
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Executar automação</DialogTitle>
          <DialogDescription>{client.trade_name || client.legal_name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="run-competence">Competência</Label>
            <CompetenceSelect id="run-competence" value={competence} onChange={(v) => { setCompetence(v); setDuplicate(false); }} />
          </div>
          <div className="space-y-2">
            <Label>Operações</Label>
            {EXPORT_OPERATIONS.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ops.includes(o.value)}
                  onCheckedChange={(v) =>
                    setOps((prev) => (v === true ? [...new Set([...prev, o.value])] : prev.filter((x) => x !== o.value)))
                  }
                />
                {o.label}
                {!client[o.flag] ? <span className="text-xs text-muted-foreground">(desabilitado no cadastro)</span> : null}
              </label>
            ))}
          </div>
          {canForce ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={force} onCheckedChange={setForce} /> Forçar novo agendamento
            </label>
          ) : null}
          {duplicate ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Exportação já agendada.</p>
              <p className="text-xs">Já existe solicitação válida para esta competência.</p>
              {canForce ? (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => run(true)} disabled={pending}>
                  Forçar novo agendamento
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={() => run()} disabled={pending || ops.length === 0}>
            {pending ? <Loader2 className="animate-spin" /> : <Play />} Iniciar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
