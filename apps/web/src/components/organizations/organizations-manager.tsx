"use client";

import { Ban, CheckCircle2, Landmark, Loader2, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createOrganization, updateOrganization } from "@/app/actions/organizations";
import { EmptyState } from "@/components/page-header";
import { ToneBadge } from "@/components/status-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import type { PlatformOrganization } from "@/lib/types";

function parseLimit(value: string): number | null {
  const n = Number(value);
  return value.trim() === "" || !Number.isInteger(n) || n <= 0 ? null : n;
}

function CreateOrganizationDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const empty = { name: "", maxClients: "", adminName: "", adminEmail: "", adminPassword: "" };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [pending, start] = useTransition();
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    setErrors({});
    start(async () => {
      const res = await createOrganization({
        name: form.name,
        maxClients: parseLimit(form.maxClients),
        adminName: form.adminName,
        adminEmail: form.adminEmail,
        adminPassword: form.adminPassword,
      });
      if (!res.ok) {
        toast.error(res.error);
        setErrors(res.fieldErrors ?? {});
        return;
      }
      toast.success(res.message);
      setOpen(false);
      setForm(empty);
      router.refresh();
    });
  }

  const err = (k: string) => errors[k]?.[0];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Novo escritório
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo escritório</DialogTitle>
          <DialogDescription>
            Cria o escritório e o administrador dele. Os dados de cada escritório ficam separados dos demais.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Nome do escritório *</Label>
              <Input id="org-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Contabilidade Exemplo" />
              {err("name") ? <p className="text-xs text-destructive">{err("name")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-limit">Limite de empresas</Label>
              <Input
                id="org-limit"
                inputMode="numeric"
                value={form.maxClients}
                onChange={(e) => set("maxClients", e.target.value.replace(/\D/g, ""))}
                placeholder="Sem limite"
              />
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="mb-3 text-sm font-medium">Administrador do escritório</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="org-admin-name">Nome *</Label>
                <Input id="org-admin-name" value={form.adminName} onChange={(e) => set("adminName", e.target.value)} />
                {err("adminName") ? <p className="text-xs text-destructive">{err("adminName")}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-admin-email">E-mail *</Label>
                <Input id="org-admin-email" type="email" value={form.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} />
                {err("adminEmail") ? <p className="text-xs text-destructive">{err("adminEmail")}</p> : null}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="org-admin-pass">Senha inicial (opcional)</Label>
                <Input
                  id="org-admin-pass"
                  type="password"
                  autoComplete="new-password"
                  value={form.adminPassword}
                  onChange={(e) => set("adminPassword", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Em branco: o administrador recebe um convite por e-mail para criar a própria senha.
                </p>
                {err("adminPassword") ? <p className="text-xs text-destructive">{err("adminPassword")}</p> : null}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null} Criar escritório
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOrganizationDialog({ org }: { org: PlatformOrganization }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: org.name, maxClients: org.max_clients?.toString() ?? "", notes: org.notes ?? "" });
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await updateOrganization(org.id, {
        name: form.name,
        maxClients: parseLimit(form.maxClients),
        notes: form.notes.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setForm({ name: org.name, maxClients: org.max_clients?.toString() ?? "", notes: org.notes ?? "" });
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil /> Editar
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar escritório</DialogTitle>
          <DialogDescription>Nome, limite de empresas do plano e observações internas.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`name-${org.id}`}>Nome</Label>
            <Input id={`name-${org.id}`} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`limit-${org.id}`}>Limite de empresas</Label>
            <Input
              id={`limit-${org.id}`}
              inputMode="numeric"
              placeholder="Sem limite"
              value={form.maxClients}
              onChange={(e) => setForm((f) => ({ ...f, maxClients: e.target.value.replace(/\D/g, "") }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`notes-${org.id}`}>Observações (só você vê)</Label>
            <Textarea id={`notes-${org.id}`} rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusButton({ org, isOwn }: { org: PlatformOrganization; isOwn: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const suspend = org.status === "active";
  if (isOwn) return null;

  function toggle() {
    if (suspend && !window.confirm(`Suspender "${org.name}"? Os usuários deste escritório perdem o acesso na hora.`)) return;
    start(async () => {
      const res = await updateOrganization(org.id, { status: suspend ? "suspended" : "active" });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      router.refresh();
    });
  }

  return (
    <Button variant={suspend ? "outline" : "default"} size="sm" onClick={toggle} disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : suspend ? <Ban /> : <CheckCircle2 />}
      {suspend ? "Suspender" : "Reativar"}
    </Button>
  );
}

export function OrganizationsManager({ orgs, ownOrgId }: { orgs: PlatformOrganization[]; ownOrgId: string | null }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateOrganizationDialog />
      </div>
      {orgs.length === 0 ? (
        <EmptyState icon={<Landmark />} title="Nenhum escritório" description="Crie o primeiro escritório para começar." />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Escritório</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Empresas</TableHead>
                <TableHead className="text-right">Usuários</TableHead>
                <TableHead className="text-right">Agendamentos (30 dias)</TableHead>
                <TableHead>Última atividade</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgs.map((org) => {
                const atLimit = org.max_clients !== null && org.clients >= org.max_clients;
                return (
                  <TableRow key={org.id}>
                    <TableCell className="max-w-64">
                      <p className="truncate font-medium">{org.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {org.id === ownOrgId ? "Seu escritório" : `Desde ${formatDateTime(org.created_at)}`}
                        {org.notes ? ` · ${org.notes}` : ""}
                      </p>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={org.status === "active" ? "green" : "red"}>
                        {org.status === "active" ? "Ativo" : "Suspenso"}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={atLimit ? "font-medium text-orange-700" : undefined}>{org.clients}</span>
                      <span className="text-muted-foreground"> / {org.max_clients ?? "∞"}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{org.users}</TableCell>
                    <TableCell className="text-right tabular-nums">{org.jobs_30d}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {org.last_activity ? formatDateTime(org.last_activity) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <EditOrganizationDialog org={org} />
                        <StatusButton org={org} isOwn={org.id === ownOrgId} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
