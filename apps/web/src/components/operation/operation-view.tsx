import { AlertTriangle, Building2, CheckCircle2, Clock, Download, Laptop, Loader2, XCircle } from "lucide-react";
import Link from "next/link";

import { ListCard, ListEmptyText, ListHead, ListTitle, OpTags } from "@/components/data-list";
import { formatCompetence } from "@/lib/competence";
import {
  explainJob,
  hhmmOf,
  hostLines,
  jobMinutes,
  jobRobots,
  type OperationReport,
  type OpJob,
  rulerTicks,
  SLOW_MINUTES,
} from "@/lib/operation";
import { JOB_STATUS_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";

const NUM = new Intl.NumberFormat("pt-BR");

function minutesLabel(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

function Kpi({ icon, label, value, sub, tone = "neutral" }: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "neutral" | "warn" | "bad";
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card px-4 py-3 shadow-card">
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          tone === "bad" ? "bg-(--c-fdecec) text-(--c-b42323)" : tone === "warn" ? "bg-(--c-fdf4e3) text-(--c-9a6205)" : "bg-(--c-e6f4ec) text-primary",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[11px] tracking-[0.04em] text-(--c-6b6c66) uppercase">{label}</p>
        <p className="text-[18px] leading-tight font-semibold">{value}</p>
        {sub ? <p className="text-[11.5px] text-(--c-6b6c66)">{sub}</p> : null}
      </div>
    </div>
  );
}

function StatusChip({ job }: { job: OpJob }) {
  const done = job.status === "completed";
  const failed = job.status === "failed" || job.status === "certificate_required";
  const label = JOB_STATUS_LABEL[job.status] ?? job.status;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap",
        done ? "bg-(--c-e6f4ec) text-(--c-1f7a4d)" : failed ? "bg-(--c-fdecec) text-(--c-b42323)" : "bg-(--c-f2f2ef) text-(--c-4a4b46)",
      )}
    >
      {done ? <CheckCircle2 className="size-3" /> : failed ? <XCircle className="size-3" /> : <Loader2 className="size-3" />}
      {label}
    </span>
  );
}

const JOB_GRID =
  "grid grid-cols-[48px_minmax(0,1fr)_auto] gap-3 md:grid-cols-[52px_minmax(150px,1.4fr)_minmax(150px,1.3fr)_minmax(90px,0.7fr)_76px_minmax(120px,1fr)]";

function JobsCard({ report }: { report: OperationReport }) {
  const { jobs, sessions, now } = report;
  return (
    <ListCard className="mb-4">
      <ListTitle title="Trabalhos do período" count={jobs.length} />
      {jobs.length === 0 ? (
        <ListEmptyText>Nenhum trabalho no período.</ListEmptyText>
      ) : (
        <>
          <ListHead grid={JOB_GRID}>
            <span>Início</span>
            <span>Cliente</span>
            <span className="hidden md:block">Trabalho</span>
            <span className="hidden md:block">Computador</span>
            <span className="hidden md:block">Duração</span>
            <span>Resultado</span>
          </ListHead>
          {jobs.map((j) => {
            const minutes = jobMinutes(j, now);
            const slow = minutes !== null && minutes >= SLOW_MINUTES;
            const reasons = explainJob(j, sessions, now);
            const robots = jobRobots(j);
            return (
              <Link
                key={j.id}
                href={`/history/${j.id}`}
                className="block border-b border-(--c-f2f2ef) px-4 py-2.5 text-[13px] text-foreground last:border-b-0 hover:bg-(--c-fafaf8) hover:no-underline"
              >
                <div className={cn(JOB_GRID, "items-center")}>
                  <span className="font-mono text-[12.5px] text-(--c-6b6c66)">{hhmmOf(j.started_at ?? j.created_at)}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{j.client_name}</span>
                    <span className="font-mono text-[11px] text-(--c-6b6c66)">
                      {j.client_code} · {formatCompetence(j.competence)}
                      {j.force ? <span className="ml-1 text-(--c-9a6205)">· forçado</span> : null}
                    </span>
                  </span>
                  <span className="hidden md:block">
                    <OpTags ops={j.operations} />
                  </span>
                  <span className="hidden truncate text-[12.5px] md:block">{robots.join(", ") || "—"}</span>
                  <span className={cn("hidden font-mono text-[12.5px] md:block", slow && "font-semibold text-(--c-9a6205)")}>
                    {minutesLabel(minutes)}
                  </span>
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <StatusChip job={j} />
                    {j.files > 0 ? (
                      <span className="text-[11px] text-(--c-6b6c66)">
                        {j.files} arquivo(s) · {NUM.format(j.notes)} nota(s)
                      </span>
                    ) : null}
                  </span>
                </div>
                {reasons.length > 0 ? (
                  <ul className="mt-1.5 ml-[60px] flex flex-col gap-0.5 rounded-md bg-(--c-fffbf2) px-2.5 py-1.5 text-[12px] text-(--c-9a6205)">
                    {reasons.map((r) => (
                      <li key={r} className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        {r}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Link>
            );
          })}
        </>
      )}
    </ListCard>
  );
}

function ComputersCard({ report, from, to }: { report: OperationReport; from: string; to: string }) {
  const lines = hostLines(report.sessions, from, to, report.now);
  const ticks = rulerTicks(from, to);
  return (
    <ListCard className="mb-4">
      <ListTitle title="Computadores" count={lines.length} />
      {lines.length === 0 ? (
        <ListEmptyText>Nenhum robô ligado no período.</ListEmptyText>
      ) : (
        <div className="px-4 py-3">
          <div className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)] gap-x-3 gap-y-2">
            <span />
            <div className="relative h-4 text-[10.5px] text-(--c-6b6c66)">
              {ticks.map((t) => (
                <span key={t.left} className="absolute -translate-x-1/2 font-mono" style={{ left: `${t.left}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
            {lines.map((l) => (
              <div key={l.key} className="contents">
                <div className="min-w-0 text-[12.5px]">
                  <p className="flex items-center gap-1.5 truncate font-medium">
                    <Laptop className="size-3.5 shrink-0 text-(--c-6b6c66)" />
                    {l.host}
                  </p>
                  <p className="truncate text-[11px] text-(--c-6b6c66)">
                    {l.own ? "" : `${l.org_name} · `}
                    {l.version ? `robô ${l.version}` : ""}
                  </p>
                </div>
                <div className="min-w-0">
                  <div className="relative h-4 overflow-hidden rounded bg-(--c-f2f2ef)">
                    {ticks.map((t) => (
                      <span key={t.left} className="absolute top-0 h-full w-px bg-(--c-e3e3df)" style={{ left: `${t.left}%` }} />
                    ))}
                    {l.segments.map((s) => (
                      <span
                        key={s.from}
                        title={`${hhmmOf(s.from)} a ${hhmmOf(s.to)}${s.end === "abrupt" ? " · parou de repente" : s.end === "stopped" ? " · desligado" : " · ligado"}`}
                        className={cn(
                          "absolute top-0.5 h-3 rounded-sm",
                          l.own ? "bg-(--c-1f7a4d)" : "bg-(--c-a9cdb8)",
                          s.end === "abrupt" && "border-r-[3px] border-(--c-b42323)",
                        )}
                        style={{ left: `${s.left}%`, width: `${s.width}%` }}
                      />
                    ))}
                  </div>
                  {l.notes.length > 0 ? (
                    <p className={cn("mt-0.5 text-[11px]", l.notes.some((n) => n.startsWith("parou")) ? "text-(--c-b42323)" : "text-(--c-6b6c66)")}>
                      {l.notes.join(" · ")}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-(--c-6b6c66)">
            A faixa mostra quando o robô esteve rodando. Vermelho no fim = parou de repente (computador desligado ou em
            suspensão sem parar o robô). Se o computador dormir com o robô aberto, isso ainda não aparece aqui.
          </p>
        </div>
      )}
    </ListCard>
  );
}

const OFFICE_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(140px,1.2fr)_70px_100px_70px_110px_90px_110px_110px]";

function OfficesCard({ report }: { report: OperationReport }) {
  const offices = report.offices ?? [];
  return (
    <ListCard className="mb-4">
      <ListTitle title="Escritórios (só números)" count={offices.length} />
      <ListHead grid={OFFICE_GRID}>
        <span>Escritório</span>
        <span className="hidden md:block">Clientes</span>
        <span className="hidden md:block">Certificados</span>
        <span className="hidden md:block">Usuários</span>
        <span className="hidden md:block">Último acesso</span>
        <span className="hidden md:block">Robôs</span>
        <span className="hidden md:block">Trabalhos</span>
        <span>Arquivos</span>
      </ListHead>
      {offices.map((o) => (
        <div key={o.id} className={cn(OFFICE_GRID, "items-center border-b border-(--c-f2f2ef) px-4 py-2.5 text-[13px] last:border-b-0")}>
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <Building2 className="size-3.5 shrink-0 text-(--c-6b6c66)" />
            <span className="truncate">{o.name}</span>
            {o.own ? <span className="rounded bg-(--c-e6f4ec) px-1 text-[10px] text-primary">seu</span> : null}
            {o.status !== "active" ? <span className="rounded bg-(--c-fdecec) px-1 text-[10px] text-(--c-b42323)">{o.status}</span> : null}
          </span>
          <span className="hidden font-mono md:block">{o.clients}</span>
          <span className="hidden font-mono md:block">
            {o.certificates}
            {o.certificates_expired > 0 ? <span className="ml-1 text-[11px] text-(--c-b42323)">({o.certificates_expired} venc.)</span> : null}
          </span>
          <span className="hidden font-mono md:block">{o.users}</span>
          <span className="hidden font-mono text-[12px] md:block">
            {o.last_access ? `${o.last_access.slice(8, 10)}/${o.last_access.slice(5, 7)} ${hhmmOf(o.last_access)}` : "—"}
          </span>
          <span className="hidden font-mono md:block">
            <span className={o.robots_online > 0 ? "text-(--c-1f7a4d)" : "text-(--c-6b6c66)"}>{o.robots_online}</span>/{o.robots}
            <span className="ml-1 text-[10.5px] text-(--c-6b6c66)">ligados</span>
          </span>
          <span className="hidden font-mono md:block">
            {o.jobs}
            {o.jobs_failed > 0 ? <span className="ml-1 text-[11px] text-(--c-b42323)">({o.jobs_failed} erro)</span> : null}
          </span>
          <span className="font-mono">
            {o.files}
            {o.notes > 0 ? <span className="ml-1 text-[11px] text-(--c-6b6c66)">({NUM.format(o.notes)} notas)</span> : null}
          </span>
        </div>
      ))}
    </ListCard>
  );
}

function EventsCard({ report }: { report: OperationReport }) {
  const events = [...report.events].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <ListCard className="mb-4">
      <ListTitle title="Acontecimentos" count={events.length} />
      {events.length === 0 ? (
        <ListEmptyText>Nada de novo no período.</ListEmptyText>
      ) : (
        <ul>
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex items-center gap-3 border-b border-(--c-f2f2ef) px-4 py-2 text-[13px] last:border-b-0">
              <span className="w-12 shrink-0 font-mono text-[12px] text-(--c-6b6c66)">{hhmmOf(e.at)}</span>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  e.kind === "device_off" ? "bg-(--c-b42323)" : e.kind === "device_on" ? "bg-(--c-1f7a4d)" : "bg-(--c-a3a39e)",
                )}
              />
              <span className="min-w-0 flex-1">{e.text}</span>
              {!e.own && e.org_name ? (
                <span className="shrink-0 rounded bg-(--c-f2f2ef) px-1.5 py-0.5 text-[11px] text-(--c-4a4b46)">{e.org_name}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}

/** Tela "Operação do dia": indicadores, computadores, trabalhos, escritórios (dono) e acontecimentos. */
export function OperationView({ report, from, to }: { report: OperationReport; from: string; to: string }) {
  const { jobs, now } = report;
  const done = jobs.filter((j) => j.status === "completed").length;
  const failed = jobs.filter((j) => j.status === "failed" || j.status === "certificate_required").length;
  const running = jobs.length - done - failed - jobs.filter((j) => j.status === "cancelled").length;
  const slow = jobs.filter((j) => (jobMinutes(j, now) ?? 0) >= SLOW_MINUTES).length;
  const files = jobs.reduce((n, j) => n + j.files, 0);
  const notes = jobs.reduce((n, j) => n + j.notes, 0);
  const ownLines = hostLines(report.sessions.filter((s) => s.own), from, to, now);
  const live = Date.parse(now) < Date.parse(to); // o período ainda não terminou
  const online = ownLines.filter((l) => l.notes[0] === "ligado agora").length;

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<CheckCircle2 className="size-4" />}
          label="Trabalhos"
          value={jobs.length}
          sub={`${done} concluído(s) · ${failed} com erro · ${Math.max(0, running)} em andamento`}
          tone={failed > 0 ? "bad" : "neutral"}
        />
        <Kpi icon={<Clock className="size-4" />} label={`Demorados (≥ ${SLOW_MINUTES} min)`} value={slow} sub="o motivo aparece em cada um" tone={slow > 0 ? "warn" : "neutral"} />
        <Kpi icon={<Download className="size-4" />} label="Arquivos baixados" value={files} sub={`${NUM.format(notes)} nota(s)`} />
        {live ? (
          <Kpi
            icon={<Laptop className="size-4" />}
            label="Computadores ligados agora"
            value={online}
            sub={`de ${ownLines.length} que trabalharam no período`}
            tone={online === 0 ? "warn" : "neutral"}
          />
        ) : (
          <Kpi icon={<Laptop className="size-4" />} label="Computadores no período" value={ownLines.length} sub={report.org_name} />
        )}
      </div>
      <ComputersCard report={report} from={from} to={to} />
      <JobsCard report={report} />
      {report.owner ? <OfficesCard report={report} /> : null}
      <EventsCard report={report} />
    </>
  );
}
