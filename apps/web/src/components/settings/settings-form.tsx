"use client";

import { Loader2, Save } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateSetting } from "@/app/actions/misc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AppSetting } from "@/lib/types";

const LABELS: Record<string, { label: string; suffix?: string }> = {
  collector_interval_minutes: { label: "Intervalo de consulta do Collector", suffix: "minutos" },
  collector_max_checks: { label: "Máximo de consultas por agendamento", suffix: "consultas" },
  certificate_warning_days: { label: "Alerta de vencimento de certificado", suffix: "dias" },
};

function SettingRow({ setting, editable }: { setting: AppSetting; editable: boolean }) {
  const [value, setValue] = useState(String(setting.value));
  const [pending, start] = useTransition();
  const meta = LABELS[setting.key] ?? { label: setting.key };
  return (
    <div className="grid gap-2 border-b py-4 last:border-0 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="space-y-1">
        <Label htmlFor={setting.key}>{meta.label}</Label>
        <p className="text-xs text-muted-foreground">{setting.description}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={setting.key}
          className="w-28"
          value={value}
          disabled={!editable}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
        />
        {meta.suffix ? <span className="w-20 text-xs text-muted-foreground">{meta.suffix}</span> : null}
        {editable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || value === String(setting.value)}
            onClick={() =>
              start(async () => {
                const res = await updateSetting(setting.key, value);
                if (res.ok) toast.success(res.message);
                else toast.error(res.error);
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Save />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsForm({ settings, editable }: { settings: AppSetting[]; editable: boolean }) {
  return (
    <div>
      {settings.map((s) => (
        <SettingRow key={s.key} setting={s} editable={editable} />
      ))}
    </div>
  );
}
