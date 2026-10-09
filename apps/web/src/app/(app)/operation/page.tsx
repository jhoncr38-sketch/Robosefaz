import { Activity, ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { HelpTip } from "@/components/list-extras";
import { OperationView } from "@/components/operation/operation-view";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import {
  type OperationReport,
  PERIODS,
  parseDay,
  parsePeriod,
  periodBounds,
  shiftDay,
  todayLocal,
} from "@/lib/operation";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Operação do dia" };

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

export default async function OperationPage({ searchParams }: PageProps<"/operation">) {
  await requireSession();
  const params = await searchParams;
  const today = todayLocal();
  const day = parseDay(params.dia);
  const period = parsePeriod(params.periodo);
  const { from, to } = periodBounds(day, period);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("operation_report", { p_from: from, p_to: to });

  const href = (d: string, p: string) => `/operation?dia=${d}&periodo=${p}`;
  const prev = shiftDay(day, -1);
  const next = shiftDay(day, 1);

  return (
    <>
      <PageHeader
        title="Operação do dia"
        help={
          <HelpTip>
            <p>
              O que os robôs fizeram no período: quando cada computador esteve ligado, cada trabalho com a duração e, nos
              que demoraram, o motivo, e os acontecimentos (computador ativado, cliente novo...).
            </p>
            <p>
              Cada escritório vê só os próprios trabalhos e computadores. O dono da plataforma vê também um resumo em números
              dos outros escritórios, sem clientes nem notas.
            </p>
          </HelpTip>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border bg-card">
          <Link href={href(prev, period)} aria-label="Dia anterior" className="grid h-8 w-8 place-items-center text-(--c-6b6c66) hover:text-foreground">
            <ChevronLeft className="size-4" />
          </Link>
          <span className="px-2 font-mono text-[13px]">{dayLabel(day)}</span>
          {next <= today ? (
            <Link href={href(next, period)} aria-label="Próximo dia" className="grid h-8 w-8 place-items-center text-(--c-6b6c66) hover:text-foreground">
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span className="grid h-8 w-8 place-items-center text-(--c-d9d9d4)">
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
        {day !== today ? (
          <Link href={href(today, period)} className="text-xs font-medium text-primary">
            Hoje
          </Link>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={href(day, p.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium hover:no-underline",
                p.key === period
                  ? "border-transparent bg-primary text-white"
                  : "border-(--c-e3e3df) bg-card text-(--c-4a4b46) hover:border-(--c-a9cdb8)",
              )}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>
      {error ? (
        <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-6 text-sm text-destructive">
          <Activity className="size-4" /> Não foi possível carregar a operação: {error.message}
        </div>
      ) : (
        <OperationView report={data as OperationReport} from={from} to={to} />
      )}
    </>
  );
}
