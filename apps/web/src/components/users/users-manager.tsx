"use client";

import { Loader2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createUser, updateUser } from "@/app/actions/users";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Profile, UserRole } from "@/lib/types";

const ROLE_HELP: Record<UserRole, string> = {
  admin: "Cadastros, certificados, automações, reprocessamento, configurações e usuários.",
  operator: "Inicia automações e consulta clientes, downloads e histórico.",
  viewer: "Somente leitura.",
};

function CreateUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "operator" as UserRole, password: "" });
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await createUser(form);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      setForm({ name: "", email: "", role: "operator", password: "" });
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus /> Novo usuário
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
          <DialogDescription>Sem senha, o usuário recebe um convite por e-mail para definir a própria senha.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="u-name">Nome</Label>
            <Input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-email">E-mail</Label>
            <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Perfil</Label>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as UserRole })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ROLE_HELP[form.role]}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-pass">Senha inicial (opcional)</Label>
            <Input
              id="u-pass"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={pending || !form.email || !form.name}>
            {pending ? <Loader2 className="animate-spin" /> : null} Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserRow({ user, isSelf }: { user: Profile; isSelf: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function change(input: { role?: UserRole; active?: boolean }) {
    start(async () => {
      const res = await updateUser(user.id, input);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
      router.refresh();
    });
  }

  return (
    <TableRow>
      <TableCell>
        <p className="font-medium">
          {user.name} {isSelf ? <span className="text-xs text-muted-foreground">(você)</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">{user.email}</p>
      </TableCell>
      <TableCell>
        <Select value={user.role} onValueChange={(v) => change({ role: v as UserRole })} disabled={pending || isSelf}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch checked={user.active} onCheckedChange={(v) => change({ active: v })} disabled={pending || isSelf} />
          <ToneBadge tone={user.active ? "green" : "gray"}>{user.active ? "Ativo" : "Inativo"}</ToneBadge>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatDateTime(user.created_at)}</TableCell>
    </TableRow>
  );
}

export function UsersManager({ users, selfId }: { users: Profile[]; selfId: string }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateUserDialog />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Perfil</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Criado em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <UserRow key={u.id} user={u} isSelf={u.id === selfId} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
