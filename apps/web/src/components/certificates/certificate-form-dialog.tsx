"use client";

import { FileKey2, Loader2, Pencil, Plus, ScanSearch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { inspectPfx, saveCertificate, saveCertificateSecret } from "@/app/actions/certificates";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatCNPJ } from "@/lib/cnpj";
import type { Certificate } from "@/lib/types";

export interface ClientOption {
  id: string;
  label: string;
  cnpj: string;
}

interface FormState {
  client_id: string;
  type: "A1" | "A3";
  subject_name: string;
  issuer: string;
  serial_number: string;
  thumbprint: string;
  valid_from: string;
  valid_until: string;
  requires_manual_selection: boolean;
  notes: string;
}

function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initial(certificate?: Certificate, clientId?: string): FormState {
  return {
    client_id: certificate?.client_id ?? clientId ?? "",
    type: certificate?.type ?? "A1",
    subject_name: certificate?.subject_name ?? "",
    issuer: certificate?.issuer ?? "",
    serial_number: certificate?.serial_number ?? "",
    thumbprint: certificate?.thumbprint ?? "",
    valid_from: toLocalInput(certificate?.valid_from),
    valid_until: toLocalInput(certificate?.valid_until),
    requires_manual_selection: certificate?.requires_manual_selection ?? false,
    notes: certificate?.notes ?? "",
  };
}

export function CertificateFormDialog({
  certificate,
  clientId,
  clients,
  trigger,
}: {
  certificate?: Certificate;
  clientId?: string;
  clients: ClientOption[];
  trigger?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(initial(certificate, clientId));
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
  const [password, setPassword] = useState("");
  const [storeSecret, setStoreSecret] = useState(false);
  const [pfxCnpj, setPfxCnpj] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [inspecting, startInspect] = useTransition();
  const [saving, startSave] = useTransition();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const selectedClient = clients.find((c) => c.id === form.client_id);

  function readPfx() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Selecione o arquivo do certificado (.pfx ou .p12).");
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("password", password);
    startInspect(async () => {
      const res = await inspectPfx(fd);
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "Falha ao ler certificado." : res.error);
        return;
      }
      const info = res.data;
      setForm((f) => ({
        ...f,
        type: "A1",
        subject_name: info.subject_name,
        issuer: info.issuer,
        serial_number: info.serial_number,
        thumbprint: info.thumbprint,
        valid_from: toLocalInput(info.valid_from),
        valid_until: toLocalInput(info.valid_until),
      }));
      setPfxCnpj(info.cnpj);
      toast.success("Metadados lidos do certificado. O arquivo não foi armazenado.");
    });
  }

  function submit() {
    setErrors({});
    startSave(async () => {
      const res = await saveCertificate(certificate?.id ?? null, form);
      if (!res.ok) {
        toast.error(res.error);
        setErrors(res.fieldErrors ?? {});
        return;
      }
      if (storeSecret && password && res.data) {
        const secretRes = await saveCertificateSecret(res.data.id, password);
        if (secretRes.ok) toast.success(secretRes.message);
        else toast.error(`Certificado salvo, mas a senha não foi armazenada: ${secretRes.error}`);
      }
      toast.success(res.message);
      setPassword("");
      setOpen(false);
      router.refresh();
    });
  }

  const fieldError = (k: keyof FormState) => errors[k]?.[0];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setForm(initial(certificate, clientId));
          setPassword("");
          setPfxCnpj(null);
          setStoreSecret(false);
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={certificate ? "outline" : "default"}>
            {certificate ? <Pencil /> : <Plus />} {certificate ? "Editar" : "Associar certificado"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{certificate ? "Editar certificado" : "Associar certificado digital"}</DialogTitle>
          <DialogDescription>
            O certificado A1 precisa estar instalado no Windows da máquina do worker. Aqui registramos seus dados e a
            validade — o arquivo nunca é armazenado.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label>Cliente *</Label>
            <Select value={form.client_id} onValueChange={(v) => set("client_id", v)} disabled={Boolean(certificate || clientId)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Selecione o cliente" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label} · {formatCNPJ(c.cnpj)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError("client_id") ? <p className="text-xs text-destructive">{fieldError("client_id")}</p> : null}
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-medium">
              <FileKey2 className="size-4" /> Ler dados do arquivo PFX (opcional)
            </p>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="pfx">Arquivo .pfx / .p12</Label>
                <Input id="pfx" ref={fileRef} type="file" accept=".pfx,.p12,application/x-pkcs12" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pfx-password">Senha do certificado</Label>
                <Input
                  id="pfx-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="button" variant="outline" onClick={readPfx} disabled={inspecting}>
                {inspecting ? <Loader2 className="animate-spin" /> : <ScanSearch />} Ler
              </Button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={storeSecret} onCheckedChange={(v) => setStoreSecret(v === true)} disabled={!password} />
              Guardar a senha no cofre seguro do worker (Windows Credential Manager). Nunca é salva no banco.
            </label>
            {pfxCnpj && selectedClient && pfxCnpj !== selectedClient.cnpj ? (
              <Alert className="mt-3 border-amber-200 bg-amber-50 text-amber-900">
                <AlertDescription className="text-amber-900">
                  O CNPJ do certificado ({formatCNPJ(pfxCnpj)}) é diferente do cliente ({formatCNPJ(selectedClient.cnpj)}).
                  Isso é esperado apenas para certificado de procurador/contador.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="subject">Titular (subject) *</Label>
              <Input id="subject" value={form.subject_name} onChange={(e) => set("subject_name", e.target.value)} placeholder="EMPRESA LTDA:00000000000000" />
              {fieldError("subject_name") ? <p className="text-xs text-destructive">{fieldError("subject_name")}</p> : null}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="issuer">Emissor (issuer)</Label>
              <Input id="issuer" value={form.issuer} onChange={(e) => set("issuer", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="serial">Número de série</Label>
              <Input id="serial" className="font-mono" value={form.serial_number} onChange={(e) => set("serial_number", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="thumb">Thumbprint (SHA-1)</Label>
              <Input id="thumb" className="font-mono" value={form.thumbprint} onChange={(e) => set("thumbprint", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">Válido de</Label>
              <Input id="from" type="datetime-local" value={form.valid_from} onChange={(e) => set("valid_from", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="until">Válido até *</Label>
              <Input id="until" type="datetime-local" value={form.valid_until} onChange={(e) => set("valid_until", e.target.value)} />
              {fieldError("valid_until") ? <p className="text-xs text-destructive">{fieldError("valid_until")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={form.type} onValueChange={(v) => set("type", v as "A1" | "A3")}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A1">A1</SelectItem>
                  <SelectItem value="A3">A3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-start gap-2 self-end text-sm">
              <Switch checked={form.requires_manual_selection} onCheckedChange={(v) => set("requires_manual_selection", v)} />
              <span>
                Seleção manual do certificado
                <span className="block text-xs text-muted-foreground">O robô sempre aguardará o usuário escolher.</span>
              </span>
            </label>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="cert-notes">Observações</Label>
              <Textarea id="cert-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
