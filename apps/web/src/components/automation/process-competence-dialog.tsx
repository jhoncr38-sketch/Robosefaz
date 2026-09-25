"use client";

import { CalendarRange } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AutomationPlanner } from "@/components/automation/automation-planner";
import type { PlannerClient } from "@/components/automation/planner-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ProcessCompetenceDialog({ clients, canForce }: { clients: PlannerClient[]; canForce: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg">
          <CalendarRange /> Processar competência
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Processar competência</DialogTitle>
          <DialogDescription>
            Escolha o mês, selecione os clientes, revise as operações e confirme para criar as tarefas.
          </DialogDescription>
        </DialogHeader>
        <AutomationPlanner
          clients={clients}
          canForce={canForce}
          compact
          onDone={(s) => {
            if (s.created > 0) {
              setOpen(false);
              router.push("/queue");
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
