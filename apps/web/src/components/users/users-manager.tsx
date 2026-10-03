"use client";

import { Loader2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createUser, updateUser } from "@/app/actions/users";
import { ListCard, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
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
import { formatDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Profile, UserRole } from "@/lib/types";

const ROLE_HELP: Record<UserRole, string> = {
  admin: "Cadastros, certificados, automações, reprocessamento, configurações e usuários.",
  operator: "Cadastra e edita empresas e certificados, agenda, força e reprocessa automações.",
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

// sem rolagem lateral: no celular a linha quebra (usuário em cima, perfil e status embaixo)
const GRID = "flex flex-wrap gap-3 md:grid md:grid-cols-[minmax(0,1.5fr)_190px_150px_130px]";

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
    <ListRow grid={GRID}>
      <PrimaryCell
        className="basis-full md:basis-auto"
        title={
          <>
            {user.name} {isSelf ? <span className="text-xs font-normal text-(--c-6b6c66)">(você)</span> : null}
          </>
        }
        sub={user.email}
      />
      <Select value={user.role} onValueChange={(v) => change({ role: v as UserRole })} disabled={pending || isSelf}>
        <SelectTrigger className="h-8 w-44">
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
      <div className="flex items-center gap-2">
        <Switch checked={user.active} onCheckedChange={(v) => change({ active: v })} disabled={pending || isSelf} />
        <ToneBadge tone={user.active ? "green" : "gray"}>{user.active ? "Ativo" : "Inativo"}</ToneBadge>
      </div>
      <span className="hidden text-xs text-(--c-6b6c66) tabular-nums md:block">{formatDateTime(user.created_at)}</span>
    </ListRow>
  );
}

export function UsersManager({ users, selfId }: { users: Profile[]; selfId: string }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateUserDialog />
      </div>
      <ListCard>
        <ListHead grid="hidden md:grid md:grid-cols-[minmax(0,1.5fr)_190px_150px_130px] md:gap-3">
          <span>Usuário</span>
          <span>Perfil</span>
          <span>Status</span>
          <span>Criado em</span>
        </ListHead>
        {users.map((u) => (
          <UserRow key={u.id} user={u} isSelf={u.id === selfId} />
        ))}
      </ListCard>
    </div>
  );
}
