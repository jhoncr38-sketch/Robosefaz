"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { setOrgNfseEmit } from "@/app/actions/nfse-emit";
import { Switch } from "@/components/ui/switch";

export interface EmitOffice {
  id: string;
  name: string;
  nfse_emit_enabled: boolean;
}

/** Dono da plataforma: em quais escritórios a emissão de NFS-e está ligada. */
export function EmitOffices({ offices }: { offices: EmitOffice[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function toggle(office: EmitOffice, enabled: boolean) {
    startTransition(async () => {
      const res = await setOrgNfseEmit(office.id, enabled);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Salvo.");
      router.refresh();
    });
  }

  return (
    <section className="overflow-clip rounded-xl border bg-card shadow-card">
      <header className="border-b border-(--c-efefeb) px-4 py-2.5">
        <h2 className="text-[13.5px] font-semibold">Escritórios com a emissão ligada</h2>
        <p className="text-[12px] text-(--c-6b6c66)">Só você vê este quadro. A emissão é uma função à parte: cada escritório só emite depois que você liga aqui.</p>
      </header>
      <ul>
        {offices.map((o) => (
          <li key={o.id} className="flex items-center gap-3 border-b border-(--c-efefeb) px-4 py-2 text-[13px] last:border-b-0">
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            <span className="text-[12px] text-(--c-6b6c66)">{o.nfse_emit_enabled ? "Ligada" : "Desligada"}</span>
            <Switch checked={o.nfse_emit_enabled} disabled={pending} onCheckedChange={(v) => toggle(o, v)} aria-label={`Emissão de NFS-e para ${o.name}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
