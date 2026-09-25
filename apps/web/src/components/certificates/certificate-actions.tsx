"use client";

import { Copy, KeyRound, Loader2, MonitorCog, PowerOff, ScrollText, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  deactivateCertificate,
  deleteCertificateSecret,
  getChromePolicy,
  openBrowserProfile,
  saveCertificateSecret,
  type ChromePolicyPreview,
} from "@/app/actions/certificates";
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
import type { Certificate } from "@/lib/types";

export function SecretDialog({ certificate }: { certificate: Certificate }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const res = await saveCertificateSecret(certificate.id, secret);
      if (res.ok) {
        toast.success(res.message);
        setOpen(false);
        setSecret("");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteCertificateSecret(certificate.id);
      if (res.ok) {
        toast.success(res.message);
        setOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound /> {certificate.has_secret ? "Senha no cofre" : "Guardar senha"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Senha do certificado</DialogTitle>
          <DialogDescription>
            A senha é enviada diretamente ao worker e gravada no Windows Credential Manager (ou em arquivo cifrado com
            SECRET_ENCRYPTION_KEY). Ela nunca é salva no banco nem registrada em logs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="secret">Nova senha</Label>
          <Input id="secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        <DialogFooter className="sm:justify-between">
          {certificate.has_secret ? (
            <Button variant="destructive" onClick={remove} disabled={pending}>
              <Trash2 /> Remover do cofre
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} disabled={pending || !secret}>
            {pending ? <Loader2 className="animate-spin" /> : null} Salvar no cofre
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ChromePolicyDialog({ certificate }: { certificate: Certificate }) {
  const [policy, setPolicy] = useState<ChromePolicyPreview | null>(null);
  const [pending, start] = useTransition();

  function load() {
    start(async () => {
      const res = await getChromePolicy(certificate.id);
      if (res.ok && res.data) setPolicy(res.data);
      else if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <Dialog onOpenChange={(v) => v && load()}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ScrollText /> Política do Chrome
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AutoSelectCertificateForUrls</DialogTitle>
          <DialogDescription>
            Política opcional que faz o Chrome escolher este certificado automaticamente para o SIAT. Revise antes de
            aplicar; nada é gravado no Windows sem confirmação. Veja docs/certificate-setup.md.
          </DialogDescription>
        </DialogHeader>
        {pending || !policy ? (
          <div className="flex justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Chave do Registro</p>
              <p className="font-mono text-xs">{policy.registry_key}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Valor</p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{policy.value}</pre>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Arquivo .reg (para aplicação manual revisada)</p>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(policy.reg_file);
                    toast.success("Conteúdo copiado.");
                  }}
                >
                  <Copy /> Copiar
                </Button>
              </div>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">{policy.reg_file}</pre>
            </div>
            <p className="text-xs text-muted-foreground">
              Modo atual: <strong>{policy.mode}</strong> · escrita automática {policy.write_enabled ? "habilitada" : "desabilitada"} (CHROME_POLICY_ALLOW_WRITE).
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OpenProfileButton({ clientId }: { clientId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await openBrowserProfile(clientId);
          if (res.ok) toast.success(res.message, { description: res.data?.message });
          else toast.error(res.error);
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <MonitorCog />} Abrir perfil do navegador
    </Button>
  );
}

export function DeactivateCertificateButton({ certificate }: { certificate: Certificate }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!certificate.active) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await deactivateCertificate(certificate.id);
          if (res.ok) {
            toast.success(res.message);
            router.refresh();
          } else toast.error(res.error);
        })
      }
    >
      <PowerOff /> Desativar
    </Button>
  );
}
