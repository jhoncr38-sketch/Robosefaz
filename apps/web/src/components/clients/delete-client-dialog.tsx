"use client";

import { Loader2, PowerOff, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteClient, setClientActive } from "@/app/actions/clients";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Client } from "@/lib/types";

/**
 * "Excluir" na página do cliente (só administrador).
 * Sem histórico: exclui de vez. Com agendamentos ou notas: não exclui (o histórico
 * sumiria junto) e oferece Desativar, que tira o cliente das automações.
 */
export function DeleteClientDialog({
  client,
  jobs,
  downloads,
}: {
  client: Client;
  jobs: number;
  downloads: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const hasHistory = jobs + downloads > 0;
  const name = client.trade_name || client.legal_name;

  function remove() {
    start(async () => {
      const res = await deleteClient(client.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      router.push("/clients");
      router.refresh();
    });
  }

  function deactivate() {
    start(async () => {
      const res = await setClientActive(client.id, false);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      router.refresh();
    });
  }

  const history = [
    jobs ? `${jobs} agendamento${jobs > 1 ? "s" : ""}` : null,
    downloads ? `${downloads} nota${downloads > 1 ? "s" : ""} baixada${downloads > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" e ");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">
          <Trash2 /> Excluir
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {hasHistory ? (
          <>
            <DialogHeader>
              <DialogTitle>Este cliente não pode ser excluído</DialogTitle>
              <DialogDescription>
                {name} já tem {history}. Excluir apagaria esse histórico junto.
                {client.active
                  ? " Se ele não deve mais ser atendido, desative: sai das automações e o histórico continua."
                  : " Ele já está desativado e fora das automações."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Fechar
              </Button>
              {client.active ? (
                <Button onClick={deactivate} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <PowerOff />} Desativar cliente
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Excluir {client.client_code}?</DialogTitle>
              <DialogDescription>
                O cadastro de <strong>{name}</strong> e o certificado registrado no painel serão apagados. O .pfx
                instalado nos computadores com o robô não é tocado. Não dá para desfazer.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={remove} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Excluir definitivamente
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
