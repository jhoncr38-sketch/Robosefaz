"use client";

import { Ban, Copy, Laptop, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createActivationCode, revokeDevice } from "@/app/actions/devices";
import { ListCard, ListHead, ListRow, PrimaryCell } from "@/components/data-list";
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
} from "@/components/ui/dialog";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { Device } from "@/lib/types";

const RELEASES_URL = "https://github.com/jhoncr38-sketch/siat-robo-releases/releases/latest";

// sem rolagem lateral: no celular, computador (com versão e sinal embaixo), situação e ação
const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 md:grid-cols-[minmax(0,1.3fr)_110px_80px_minmax(0,1fr)_130px_120px]";

function online(device: Device, now: number): boolean {
  return device.status === "active" && !!device.last_seen_at && now - new Date(device.last_seen_at).getTime() < 120_000;
}

function AddDeviceButton() {
  const [pending, start] = useTransition();
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);

  function generate() {
    start(async () => {
      const res = await createActivationCode();
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "Não foi possível gerar o código." : res.error);
        return;
      }
      setCode(res.data);
    });
  }

  return (
    <>
      <Button onClick={generate} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Plus />} Adicionar computador
      </Button>
      <Dialog open={code !== null} onOpenChange={(v) => !v && setCode(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Código de ativação</DialogTitle>
            <DialogDescription>
              Válido até {code ? formatDateTime(code.expires_at) : ""} (30 minutos) e só pode ser usado uma vez.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-center gap-3 rounded-lg border bg-muted/40 py-5">
            <span className="font-mono text-3xl font-semibold tracking-[0.2em]">{code?.code}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copiar código"
              onClick={() => {
                if (code) void navigator.clipboard.writeText(code.code).then(() => toast.success("Código copiado."));
              }}
            >
              <Copy />
            </Button>
          </div>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              No computador novo, instale os certificados A1 (.pfx) dos clientes e baixe o instalador em{" "}
              <a className="text-foreground underline" href={RELEASES_URL} target="_blank" rel="noreferrer">
                Releases
              </a>
              .
            </li>
            <li>
              Na tela <strong>Ativar este computador</strong> do instalador, digite o código acima.
            </li>
            <li>
              Computador que já tem o robô: menu Iniciar → JR Sistema → <strong>Ativar este computador</strong>.
            </li>
          </ol>
          <DialogFooter>
            <Button onClick={() => setCode(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevokeButton({ device }: { device: Device }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (device.status !== "active") return null;

  function revoke() {
    if (!window.confirm(`Desativar "${device.name}"? O robô deste computador para de funcionar na hora.`)) return;
    start(async () => {
      const res = await revokeDevice(device.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={revoke} disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <Ban />} Desativar
    </Button>
  );
}

export function DevicesManager({ devices, canManage, now }: { devices: Device[]; canManage: boolean; now: number }) {
  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <AddDeviceButton />
        </div>
      ) : null}
      {devices.length === 0 ? (
        <EmptyState
          icon={<Laptop />}
          title="Nenhum computador ativado"
          description="Adicione o computador onde o robô vai rodar. Ele precisa ter os certificados dos clientes instalados."
        />
      ) : (
        <ListCard>
          <ListHead grid={GRID}>
            <span>Computador</span>
            <span>Situação</span>
            <span className="hidden md:block">Versão</span>
            <span className="hidden md:block">Último sinal</span>
            <span className="hidden md:block">Ativado em</span>
            <span />
          </ListHead>
          {devices.map((d) => {
            const on = online(d, now);
            const seen = d.last_seen_at ? formatRelative(d.last_seen_at) : "nunca";
            return (
              <ListRow key={d.id} grid={GRID}>
                <PrimaryCell
                  title={d.name}
                  sub={<span className="md:hidden">versão {d.robot_version ?? "—"} · sinal {seen}</span>}
                />
                <div>
                  {d.status === "revoked" ? (
                    <ToneBadge tone="gray">Desativado</ToneBadge>
                  ) : (
                    <ToneBadge tone={on ? "green" : "yellow"}>{on ? "Online" : "Offline"}</ToneBadge>
                  )}
                </div>
                <span className="hidden font-mono text-[12.5px] md:block">{d.robot_version ?? "—"}</span>
                <span className="hidden text-xs text-(--c-6b6c66) md:block">{seen}</span>
                <span className="hidden text-xs text-(--c-6b6c66) tabular-nums md:block">{formatDateTime(d.activated_at)}</span>
                <div className="flex justify-end">{canManage ? <RevokeButton device={d} /> : null}</div>
              </ListRow>
            );
          })}
        </ListCard>
      )}
    </div>
  );
}
