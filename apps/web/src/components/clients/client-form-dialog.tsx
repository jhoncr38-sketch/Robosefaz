"use client";

import { Loader2, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { saveClient } from "@/app/actions/clients";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatCNPJ, maskCNPJ, validateCNPJ } from "@/lib/cnpj";
import type { Client } from "@/lib/types";
import type { ClientInput } from "@/lib/validation";

function defaults(client?: Client): ClientInput {
  return {
    legal_name: client?.legal_name ?? "",
    trade_name: client?.trade_name ?? "",
    cnpj: client ? formatCNPJ(client.cnpj) : "",
    state_registration: client?.state_registration ?? "",
    uf: client?.uf ?? "PI",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    active: client?.active ?? true,
    uses_nfce: client?.uses_nfce ?? true,
    uses_nfe_issued: client?.uses_nfe_issued ?? true,
    uses_nfe_received: client?.uses_nfe_received ?? true,
    notes: client?.notes ?? "",
  };
}

export function ClientFormDialog({ client, trigger }: { client?: Client; trigger?: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [serverErrors, setServerErrors] = useState<Record<string, string[] | undefined>>({});
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<ClientInput>({ defaultValues: defaults(client) });

  function onSubmit(values: ClientInput) {
    setServerErrors({});
    startTransition(async () => {
      const res = await saveClient(client?.id ?? null, values);
      if (!res.ok) {
        toast.error(res.error);
        setServerErrors(res.fieldErrors ?? {});
        return;
      }
      toast.success(res.message);
      setOpen(false);
      if (!client) reset(defaults());
      router.refresh();
      if (!client && res.data) router.push(`/clients/${res.data.id}`);
    });
  }

  const err = (name: keyof ClientInput) => errors[name]?.message ?? serverErrors[name]?.[0];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) reset(defaults(client));
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            {client ? <Pencil /> : <Plus />} {client ? "Editar" : "Novo cliente"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{client ? `Editar ${client.client_code}` : "Novo cliente"}</DialogTitle>
          <DialogDescription>Dados cadastrais e configurações usadas pelo robô no SIAT.</DialogDescription>
        </DialogHeader>
        <form id="client-form" onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="legal_name">Razão social *</Label>
              <Input id="legal_name" {...register("legal_name", { required: "Informe a razão social" })} aria-invalid={!!err("legal_name")} />
              {err("legal_name") ? <p className="text-xs text-destructive">{err("legal_name")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trade_name">Nome fantasia</Label>
              <Input id="trade_name" {...register("trade_name")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cnpj">CNPJ *</Label>
              <Controller
                control={control}
                name="cnpj"
                rules={{ validate: (v) => validateCNPJ(v) || "CNPJ inválido" }}
                render={({ field }) => (
                  <Input
                    id="cnpj"
                    placeholder="00.000.000/0000-00"
                    value={field.value}
                    onChange={(e) => field.onChange(maskCNPJ(e.target.value))}
                    onBlur={field.onBlur}
                    aria-invalid={!!err("cnpj")}
                    className="font-mono"
                  />
                )}
              />
              {err("cnpj") ? <p className="text-xs text-destructive">{err("cnpj")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="state_registration">Inscrição estadual</Label>
              <Input id="state_registration" {...register("state_registration")} />
              <p className="text-[11px] text-muted-foreground">Usada para desempate na seleção do contribuinte.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="uf">UF *</Label>
              <Input id="uf" maxLength={2} className="w-20 uppercase" {...register("uf")} aria-invalid={!!err("uf")} />
              {err("uf") ? <p className="text-xs text-destructive">{err("uf")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" {...register("email")} aria-invalid={!!err("email")} />
              {err("email") ? <p className="text-xs text-destructive">{err("email")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Telefone</Label>
              <Input id="phone" {...register("phone")} />
            </div>
          </div>

          <Separator />
          <div className="space-y-3">
            <p className="text-sm font-medium">Configurações SIAT</p>
            {(
              [
                ["uses_nfce", "Utiliza NFC-e"],
                ["uses_nfe_issued", "Utiliza NF-e emitidas"],
                ["uses_nfe_received", "Utiliza NF-e recebidas"],
              ] as const
            ).map(([name, label]) => (
              <Controller
                key={name}
                control={control}
                name={name}
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                    {label}
                  </label>
                )}
              />
            ))}
          </div>

          <Separator />
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="notes">Observações</Label>
              <Textarea id="notes" rows={2} {...register("notes")} />
            </div>
            <Controller
              control={control}
              name="active"
              render={({ field }) => (
                <label className="flex items-center gap-2 self-start pt-6 text-sm">
                  <Switch checked={field.value} onCheckedChange={field.onChange} /> Ativo
                </label>
              )}
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="client-form" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
