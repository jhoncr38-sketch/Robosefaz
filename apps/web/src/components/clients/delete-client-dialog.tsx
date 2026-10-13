"use client";

import { Loader2, PowerOff, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { deleteClient, setClientActive } from "@/app/actions/clients";
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
import type { Client } from "@/lib/types";

/**
 * "Excluir" na página do cliente (só administrador).
 * Sem histórico: exclui de vez. Com agendamentos ou notas: oferece Desativar (sai das automações, o
 * histórico fica) e, com uma confirmação à parte, excluir levando o histórico junto. Os arquivos na
 * pasta de notas e o .pfx instalado nos computadores nunca são tocados.
 */
export function DeleteClientDialog({
  client,
  jobs,
  downloads,
  notes = 0,
  certificates = 0,
}: {
  client: Client;
  jobs: number;
  downloads: number;
  notes?: number;
  certificates?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [withHistory, setWithHistory] = useState(false);
  const [pending, start] = useTransition();
  const hasHistory = jobs + downloads > 0;
  const name = client.trade_name || client.legal_name;

  function remove(force: boolean) {
    start(async () => {
      const res = await deleteClient(client.id, force);
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

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const history = [
    jobs ? plural(jobs, "trabalho", "trabalhos") : null,
    downloads ? plural(downloads, "arquivo baixado", "arquivos baixados") : null,
    notes ? plural(notes, "nota no índice", "notas no índice") : null,
    certificates ? plural(certificates, "certificado no painel", "certificados no painel") : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setWithHistory(false);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive">
          <Trash2 /> Excluir
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {hasHistory ? (
          <>
            <DialogHeader>
              <DialogTitle>{name} já tem histórico</DialogTitle>
              <DialogDescription>
                Este cliente tem {history}.
                {client.active
                  ? " Se ele não deve mais ser atendido, desative: sai das automações e o histórico continua."
                  : " Ele já está desativado e fora das automações."}
              </DialogDescription>
            </DialogHeader>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-(--c-f0c9c9) bg-(--c-fdecec) px-3 py-2.5 text-[13px] leading-[1.45]">
              <Checkbox checked={withHistory} onCheckedChange={(v) => setWithHistory(v === true)} className="mt-0.5" />
              <span>
                <b className="font-semibold">Excluir mesmo assim, com o histórico.</b> Apaga o cadastro, os trabalhos, os
                registros de download, as notas do índice, as consultas de EFD e malhas e o certificado registrado no
                painel. Os arquivos na pasta de notas e o .pfx instalado nos computadores continuam. Não dá para desfazer.
              </span>
            </label>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Fechar
              </Button>
              {client.active && !withHistory ? (
                <Button onClick={deactivate} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <PowerOff />} Desativar cliente
                </Button>
              ) : null}
              {withHistory ? (
                <Button variant="destructive" onClick={() => remove(true)} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Excluir com o histórico
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
              <Button variant="destructive" onClick={() => remove(false)} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Excluir definitivamente
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
