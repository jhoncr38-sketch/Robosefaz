import { CalendarCheck, CalendarClock, Hourglass } from "lucide-react";

import { type AdnDelayNotice, type MonthClosing, monthName, shortDay } from "@/lib/nfse-atraso";
import { cn } from "@/lib/utils";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="sm:min-w-[108px]">
      <p className="text-[11px] text-(--c-6b6c66)">{label}</p>
      <p className="text-[13px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** O mês anterior nesta cidade: as notas atrasadas já chegaram? As buscas foram feitas depois disso?
 *  É um indício para fechar o mês, não uma prova (nota ainda não repassada não aparece em lugar nenhum). */
function MonthLine({ month, closing }: { month: string; closing: MonthClosing }) {
  const ok = closing.situacao === "provavel";
  const late = closing.atrasadas > 0 && closing.ultimaChegada;
  const Icon = ok ? CalendarCheck : CalendarClock;
  return (
    <div className="col-span-full -mx-4 mt-1 -mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-dashed border-(--c-e3e3df) bg-(--c-fafaf8) px-4 py-2 text-[12.5px]">
      <Icon className="size-3.5 shrink-0 text-(--c-6b6c66)" />
      <p className="min-w-0 flex-1 basis-[280px] text-(--c-4a4b46)">
        <b className="font-semibold text-foreground capitalize">{monthName(month)}</b>:{" "}
        {/* uma frase só, do jeito que a pessoa perguntaria: as notas do mês já estão aqui? */}
        {ok
          ? late
            ? `as notas atrasadas chegaram até ${shortDay(closing.ultimaChegada!)} e já foram baixadas.`
            : "nenhuma nota atrasou e todas já foram baixadas."
          : !closing.buscaMaisAntiga
            ? "nenhuma empresa foi buscada ainda."
            : late
              ? `chegaram notas atrasadas até ${shortDay(closing.ultimaChegada!)}, e ${plural(closing.buscasAntigas, "empresa ainda não foi buscada", "empresas ainda não foram buscadas")} depois disso.`
              : `${plural(closing.buscasAntigas, "empresa ainda não foi buscada", "empresas ainda não foram buscadas")} depois que o mês acabou.`}
      </p>
      <span
        title={
          ok
            ? "É um indício, não uma prova: uma nota que a prefeitura ainda não repassou não aparece em lugar nenhum. Confira também se não falta número na sequência das notas prestadas."
            : "Busque as NFS-e de novo para trazer o que a prefeitura repassou depois da última busca."
        }
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-px text-[11.5px] font-medium whitespace-nowrap",
          ok ? "border-(--c-d3ebdc) bg-(--c-e8f6ee) text-(--c-1c7a47)" : "border-(--c-f3dfb4) bg-(--c-fdf4e3) text-(--c-9a6205)",
        )}
      >
        {ok ? "Provavelmente completo" : "Busque de novo"}
      </span>
    </div>
  );
}

/** Prefeituras que estão demorando a repassar as NFS-e ao ambiente nacional: uma linha por cidade, com a
 *  situação do mês anterior logo abaixo. Só aparece quando há atraso que importa (quem decide é delayNotices). */
export function AdnDelayCard({ notices, month, closings }: { notices: AdnDelayNotice[]; month: string; closings: Record<string, MonthClosing> }) {
  if (!notices.length) return null;
  return (
    <section className="mb-4 overflow-clip rounded-xl border bg-card shadow-card">
      <header className="flex items-start gap-3 px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-(--c-fdf4e3) text-(--c-9a6205)">
          <Hourglass className="size-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Repasse ao ambiente nacional com atraso</h2>
          <p className="text-[12.5px] leading-[1.45] text-(--c-6b6c66)">
            Nota emitida no site da prefeitura pode levar dias para aparecer aqui. Se faltar uma recente, busque de novo depois.
          </p>
        </div>
        <span className="shrink-0 pt-0.5 text-[12px] whitespace-nowrap text-(--c-6b6c66)">últimos 30 dias</span>
      </header>
      <ul>
        {notices.map((n) => (
          <li
            key={n.codigo}
            className="grid items-center gap-x-6 gap-y-2 border-t border-(--c-efefeb) px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto_auto]"
          >
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-medium">{n.cidade}</p>
              <p className="font-mono text-[11.5px] text-(--c-6b6c66)">
                {n.notas} nota{n.notas === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-full bg-(--c-efefeb)" aria-hidden>
                <span className="block h-full rounded-full bg-(--c-e0a019)" style={{ width: `${Math.max(n.atrasadas, 2)}%` }} />
              </span>
              <span className="text-[12.5px] whitespace-nowrap">
                <b className="font-semibold tabular-nums">{n.atrasadas}%</b> <span className="text-(--c-6b6c66)">com mais de um dia</span>
              </span>
            </div>
            <Stat label="Metade em até" value={n.tipico} />
            <Stat label="A mais demorada" value={n.pior} />
            {closings[n.codigo] ? <MonthLine month={month} closing={closings[n.codigo]} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
