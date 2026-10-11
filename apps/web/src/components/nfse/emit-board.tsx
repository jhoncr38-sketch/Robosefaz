"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Copy,
  Download,
  FileText,
  FlaskConical,
  History,
  ListPlus,
  Loader2,
  Lock,
  type LucideIcon,
  PenLine,
  Plus,
  ReceiptText,
  Repeat2,
  RotateCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { retryJob } from "@/app/actions/automation";
import {
  cancelEmission,
  createEmission,
  loadEmission,
  loadEmissionXml,
  loadEmitNotes,
  lookupTaker,
  readEmitRequest,
} from "@/app/actions/nfse-emit";
import { useRobotState } from "@/components/layout/robot-status-pill";
import { SearchSelect } from "@/components/nfse/search-select";
import { ToneBadge } from "@/components/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import {
  buildEmitProfile,
  CANCEL_REASONS,
  checkDraft,
  clientNotice,
  emissionState,
  emissionSteps,
  explainRejection,
  formatAmountInput,
  formatBRL,
  formatDoc,
  formatServiceCode,
  monthSummary,
  parseAmount,
  checkCodes,
  formatNbs,
  pickBaseModel,
  pickModel,
  takerNoteKey,
  type Emission,
  type EmitNote,
  type EmitActivity,
  type EmitNoteRef,
} from "@/lib/nfse-emit";
import {
  classTribLabel,
  classTribOptions,
  cstLabel,
  cstOf,
  indOpLabel,
  indOpOptions,
  nationalOptions,
  nbsLabel,
  nbsOptions,
  type NfseTables,
  onlyIndOp,
  withCurrent,
} from "@/lib/nfse-tabelas";
import { createClient, subscribeWithAuth } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export interface EmitClient {
  id: string;
  client_code: string;
  name: string;
  cnpj: string;
  certificate_ok: boolean;
  /** NFS-e prestadas que servem de modelo */
  notas: number;
}

type Mode = "ai" | "repeat" | "manual";
type TakerKind = "known" | "new" | "none";

interface NewTaker {
  doc: string;
  nome: string;
  cmun: string;
  cidade: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
}

interface Draft {
  source: Mode;
  takerKind: TakerKind;
  takerDoc: string;
  newTaker: NewTaker;
  /** código nacional|municipal; CUSTOM = outra atividade do cadastro, escolhida pelo código nacional */
  service: string;
  customNac: string;
  customMun: string;
  customName: string;
  /** o código municipal não está entre os já usados: a pessoa digita */
  munOther: boolean;
  /** digitar os códigos em vez de escolher nas listas oficiais */
  typed: boolean;
  nbs: string;
  cst: string;
  classTrib: string;
  indOp: string;
  description: string;
  amount: string;
  /** de onde veio a descrição e o valor, para a etiqueta do campo */
  origin: string;
  doubts: string[];
  read: boolean;
}

const CUSTOM = "__custom";
const onlyDigits = (v: string) => v.replace(/\D/g, "");

const EMPTY_TAKER: NewTaker = { doc: "", nome: "", cmun: "2211001", cidade: "Teresina/PI", cep: "", logradouro: "", numero: "", complemento: "", bairro: "" };

const INPUT =
  "h-8 w-full rounded-[7px] border border-input bg-card px-2.5 text-[13px] outline-none transition-colors focus:border-ring disabled:bg-(--c-f5f5f2) disabled:text-(--c-6b6c66)";
const AREA = "w-full rounded-[7px] border border-input bg-card px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-ring";
const BTN = "inline-flex h-8 items-center justify-center gap-1.5 rounded-[7px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = cn(BTN, "bg-primary font-semibold text-primary-foreground hover:bg-(--c-17603b)");
const BTN_OUTLINE = cn(BTN, "border border-(--c-d9d9d4) bg-card text-foreground hover:bg-(--c-f5f5f1)");
const BTN_DANGER = cn(BTN, "border border-(--c-f0c9c9) bg-card text-(--c-b42323) hover:bg-(--c-fdecec)");

function Tag({ tone, children }: { tone: "green" | "blue" | "amber" | "gray"; children: React.ReactNode }) {
  const cls = {
    green: "border-(--c-d3ebdc) bg-(--c-e8f6ee) text-(--c-1c7a47)",
    blue: "border-transparent bg-(--c-e8f1fd) text-(--c-1d5fb8)",
    amber: "border-(--c-f3dfb4) bg-(--c-fdf4e3) text-(--c-9a6205)",
    gray: "border-(--c-e6e6e1) bg-(--c-fafaf8) text-(--c-6b6c66)",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium whitespace-nowrap", cls)}>{children}</span>;
}

function Field({ label, tag, children }: { label: string; tag?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-xs font-medium text-(--c-6b6c66)">
        {label}
        {tag ? <span className="ml-auto">{tag}</span> : null}
      </span>
      {children}
    </label>
  );
}

const STEP_TITLE = "flex items-center gap-2 text-[13.5px] font-semibold";
const LINK = "shrink-0 text-[12.5px] font-medium whitespace-nowrap text-primary hover:underline";
/** linha clicável das listas (empresa, tomador): nome à esquerda, informação curta à direita */
const ROW = "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-(--c-f2f2ef) px-3 text-left transition-colors hover:bg-(--c-fafaf8)";

/** Círculo do passo: número enquanto falta fazer, visto quando o passo já foi resolvido. */
function StepDot({ n, done }: { n: number; done: boolean }) {
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px]", done ? "bg-(--c-e6f4ec) text-primary" : "bg-primary text-primary-foreground")}>
      {done ? <Check className="size-3" /> : n}
    </span>
  );
}

/** De onde veio o valor do campo (histórico, pedido, nota repetida): texto simples ao lado do rótulo. */
function Origin({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-[11.5px] font-normal text-(--c-6b6c66)">
      <Icon className="size-3" /> {children}
    </span>
  );
}

/** Campo composto (lista, cartão com botões): como o Field, mas sem <label>, que acionaria o primeiro botão de dentro. */
function Group({ label, tag, children }: { label: string; tag?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-xs font-medium text-(--c-6b6c66)">
        {label}
        {tag ? <span className="ml-auto">{tag}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** Ponto para conferir, logo abaixo do campo a que se refere. */
function Doubt({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.4] text-(--c-9a6205)">
      <TriangleAlert className="mt-px size-[13px] shrink-0" />
      <span>{children}</span>
    </span>
  );
}

function Notice({ tone, icon, children }: { tone: "blue" | "amber" | "green" | "red"; icon?: React.ReactNode; children: React.ReactNode }) {
  const cls = {
    blue: "border-transparent bg-(--c-e8f1fd) text-(--c-1d5fb8)",
    amber: "border-(--c-f3dfb4) bg-(--c-fdf4e3) text-(--c-9a6205)",
    green: "border-(--c-d3ebdc) bg-(--c-eef7f1) text-(--c-1c5e3c)",
    red: "border-(--c-f0c9c9) bg-(--c-fdecec) text-(--c-b42323)",
  }[tone];
  return (
    <div className={cn("flex items-start gap-2 rounded-[9px] border px-3 py-2 text-[12.5px]", cls)}>
      {icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

async function openDanfse(emission: Emission) {
  const tab = window.open("", "_blank");
  if (!tab) {
    toast.error("O navegador bloqueou a nova aba. Permita pop-ups para o painel.");
    return;
  }
  tab.document.write("<p style='font:15px Segoe UI,sans-serif;padding:24px'>Montando o DANFSE…</p>");
  const [res, mod] = await Promise.all([loadEmissionXml(emission.id), import("@/lib/danfse-nacional")]);
  const html = res.ok && res.data ? mod.danfseNacionalHtml(res.data.xml, { cancelada: res.data.canceled, logoUrl: `${window.location.origin}/nfse-logo.png` }) : null;
  tab.document.open();
  tab.document.write(html ?? `<p style='font:15px Segoe UI,sans-serif;padding:24px'>${res.ok ? "Não foi possível ler o XML desta nota." : res.error}</p>`);
  tab.document.close();
}

async function downloadXml(emission: Emission) {
  const res = await loadEmissionXml(emission.id);
  if (!res.ok || !res.data) {
    toast.error(res.ok ? "XML indisponível" : res.error);
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([res.data.xml], { type: "application/xml" }));
  link.download = `NFSe ${emission.chave ?? emission.id}.xml`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Timeline({ emission }: { emission: Emission }) {
  const steps = emissionSteps(emission);
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.key} className={cn("relative grid grid-cols-[20px_1fr_auto] items-start gap-2.5 py-1.5", s.state === "todo" && "text-(--c-9a9b94)")}>
          {i < steps.length - 1 ? (
            <span className={cn("absolute top-[26px] -bottom-1.5 left-[9px] w-[1.5px]", s.state === "done" ? "bg-primary" : "bg-(--c-e3e3df)")} aria-hidden />
          ) : null}
          <span
            className={cn(
              "grid size-5 place-items-center rounded-full border-[1.5px] bg-card",
              s.state === "done" ? "border-primary bg-primary text-primary-foreground" : s.state === "now" ? "border-primary" : "border-(--c-d4d4cf)",
            )}
          >
            {s.state === "done" ? <Check className="size-3" strokeWidth={3} /> : s.state === "now" ? <Loader2 className="size-3 animate-spin text-primary" /> : null}
          </span>
          <span className="min-w-0">
            <b className="block text-[13px] font-semibold">{s.label}</b>
            <span className="block text-[11.5px] text-(--c-6b6c66)">{s.hint}</span>
          </span>
          <span className="font-mono text-[11px] text-(--c-6b6c66) tabular-nums">{s.at ? formatTime(s.at) : ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Rejections({ emission }: { emission: Emission }) {
  if (!emission.errors?.length) return emission.last_message ? <p>{emission.last_message}</p> : null;
  return (
    <ul className="flex flex-col gap-1.5">
      {emission.errors.map((e, i) => (
        <li key={i}>
          {explainRejection(e) ? <b className="block font-semibold">{explainRejection(e)}</b> : null}
          <span className="block text-[12px] opacity-90">
            Prefeitura{e.codigo ? ` ${e.codigo}` : ""}: {e.mensagem}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EmitBoard({
  clients,
  initialEmissions,
  userNames,
  canRun,
  isOwner,
  aiReady,
  month,
  activities,
}: {
  clients: EmitClient[];
  initialEmissions: Emission[];
  userNames: Record<string, string>;
  canRun: boolean;
  isOwner: boolean;
  aiReady: boolean;
  month: string;
  activities: EmitActivity[];
}) {
  const robot = useRobotState();
  const [tab, setTab] = useState<"emit" | "list">("emit");
  const [clientId, setClientId] = useState("");
  const [notes, setNotes] = useState<EmitNote[] | null>(null);
  const [mode, setMode] = useState<Mode>(aiReady ? "ai" : "repeat");
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testEnv, setTestEnv] = useState(false);
  const [emissions, setEmissions] = useState<Emission[]>(initialEmissions);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [canceling, setCanceling] = useState<Emission | null>(null);
  const [cancelCode, setCancelCode] = useState<1 | 2 | 9>(1);
  const [cancelReason, setCancelReason] = useState("");
  const [detail, setDetail] = useState<Emission | null>(null);
  const [takerFilter, setTakerFilter] = useState("");
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyOpen, setCompanyOpen] = useState(false);
  const [takerOpen, setTakerOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  /** null = abre sozinho (outra atividade, código fora da tabela ou código incompleto); depois vale o clique */
  const [codesOpen, setCodesOpen] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  /** tomador novo: campos de nome e endereço abertos para editar */
  const [takerEdit, setTakerEdit] = useState(false);
  /** situação do CNPJ do tomador novo na Receita, como veio da busca */
  const [takerStatus, setTakerStatus] = useState<string | null>(null);
  const [listQuery, setListQuery] = useState("");
  const [listFilter, setListFilter] = useState<"all" | "issued" | "canceled" | "problem">("all");
  const [loadingNotes, startLoad] = useTransition();
  const [reading, startRead] = useTransition();
  const [sending, startSend] = useTransition();
  const [looking, startLookup] = useTransition();
  const [tables, setTables] = useState<NfseTables | null>(null);
  const [tablesFailed, setTablesFailed] = useState(false);

  // as tabelas oficiais (lista nacional, NBS, indicador, classificação) só são baixadas quando há um rascunho aberto
  const drafting = Boolean(draft);
  const nationalList = useMemo(() => (tables ? nationalOptions(tables) : []), [tables]);
  useEffect(() => {
    if (!drafting || tables) return;
    let alive = true;
    import("@/lib/nfse-tabelas-data").then(
      (data) => alive && setTables(data),
      () => alive && setTablesFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [drafting, tables]);

  const client = clients.find((c) => c.id === clientId) ?? null;
  const profile = useMemo(() => (notes ? buildEmitProfile(notes) : null), [notes]);
  const active = emissions.find((e) => e.id === activeId) ?? null;
  const activeState = active ? emissionState(active) : null;
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const summary = useMemo(() => monthSummary(emissions, month), [emissions, month]);

  // o robô grava o andamento na linha da nota: a tela acompanha em tempo real
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel("nfse-emissions").on("postgres_changes", { event: "*", schema: "public", table: "nfse_emissions" }, (payload) => {
      const row = payload.new as (Emission & { nfse_xml?: string }) | null;
      if (!row?.id) return;
      // o XML da nota não fica na tela (vem só quando alguém abre o DANFSe)
      const clean = { ...row };
      delete clean.nfse_xml;
      setEmissions((prev) => (prev.some((e) => e.id === clean.id) ? prev.map((e) => (e.id === clean.id ? { ...e, ...clean } : e)) : [clean as Emission, ...prev]));
    });
    return subscribeWithAuth(channel);
  }, []);

  // reserva: enquanto a nota em andamento não termina, confere a linha a cada 4 s
  const activeRunning = Boolean(activeState?.running);
  useEffect(() => {
    if (!activeId || !activeRunning) return;
    const timer = setInterval(async () => {
      const res = await loadEmission(activeId);
      if (res.ok && res.data) {
        const fresh = res.data;
        setEmissions((prev) => prev.map((e) => (e.id === fresh.id ? { ...e, ...fresh } : e)));
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [activeId, activeRunning]);

  function chooseClient(id: string) {
    setClientId(id);
    setCompanyQuery("");
    setNotes(null);
    setDraft(null);
    setActiveId(null);
    setRequest("");
    if (!id) return;
    startLoad(async () => {
      const res = await loadEmitNotes(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setNotes(res.data ?? []);
    });
  }

  /** NBS e IBS/CBS que a tela sugere para um serviço: os da nota mais recente dele. */
  function codesOf(source: { nbs: string; ibs: { cst: string; classTrib: string; indOp: string } | null } | null | undefined) {
    return { nbs: source?.nbs ?? "", cst: source?.ibs?.cst ?? "", classTrib: source?.ibs?.classTrib ?? "", indOp: source?.ibs?.indOp ?? "" };
  }

  function openDraft(next: Partial<Draft> & { source: Mode }) {
    setActiveId(null);
    // com o tomador já escolhido a lista começa fechada; sem tomador (à mão, ou pedido sem tomador achado), aberta
    setTakerOpen((next.takerKind ?? "known") === "known" && !next.takerDoc);
    setTakerFilter("");
    setServiceOpen(false);
    setCodesOpen(null);
    setTakerEdit(false);
    setTakerStatus(null);
    setCopied(false);
    const service = next.service ?? profile?.services[0]?.id ?? "";
    setDraft({
      takerKind: "known",
      takerDoc: "",
      newTaker: EMPTY_TAKER,
      customNac: "",
      customMun: "",
      customName: "",
      munOther: false,
      typed: false,
      ...codesOf(profile?.services.find((s) => s.id === service)),
      description: "",
      amount: "",
      origin: "",
      doubts: [],
      read: false,
      ...next,
      service,
    });
  }

  function repeat(n: EmitNoteRef) {
    openDraft({
      source: "repeat",
      takerKind: n.tomadorDoc ? "known" : "none",
      takerDoc: n.tomadorDoc ?? "",
      service: n.servico,
      ...codesOf(n),
      description: n.descricao,
      amount: formatAmountInput(n.valor),
      origin: `da nota nº ${n.numero ?? ""}`,
    });
  }

  function read() {
    if (!client) return;
    startRead(async () => {
      const res = await readEmitRequest({ clientId: client.id, text: request });
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "A IA não respondeu." : res.error);
        return;
      }
      const r = res.data;
      const doubts = [...r.doubts];
      const known = Boolean(r.takerDoc);
      if (!known) doubts.unshift(r.takerQuoted ? `Não achei “${r.takerQuoted}” entre os tomadores desta empresa. Escolha na lista ou cadastre como novo.` : "O pedido não diz claramente quem é o tomador.");
      if (!r.amount) doubts.unshift("Não consegui ler o valor com certeza. Digite o valor.");
      openDraft({
        source: "ai",
        takerKind: known ? "known" : r.document.length === 14 ? "new" : "known",
        takerDoc: r.takerDoc ?? "",
        newTaker: { ...EMPTY_TAKER, doc: r.document, nome: known ? "" : r.takerQuoted },
        service: r.service ?? profile?.services[0]?.id ?? "",
        description: r.description,
        amount: r.amount ? formatAmountInput(r.amount) : "",
        origin: "do pedido",
        doubts,
        read: true,
      });
    });
  }

  function patch(next: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...next } : d));
  }

  function chooseTaker(value: string) {
    if (value === "__new") return patch({ takerKind: "new", takerDoc: "" });
    if (value === "__none") return patch({ takerKind: "none", takerDoc: "" });
    const taker = profile?.takers.find((t) => t.doc === value);
    // o serviço (com o NBS e o IBS/CBS) acompanha a última nota para o tomador escolhido
    patch({ takerKind: "known", takerDoc: value, ...(taker ? { service: taker.ultima.servico, ...codesOf(taker.ultima) } : {}) });
  }

  function chooseService(value: string) {
    // ao abrir "outra atividade" sem código escolhido, os códigos do serviço anterior não valem mais
    if (value === CUSTOM) return patch({ service: CUSTOM, ...(draft?.customNac ? {} : codesOf(null)) });
    patch({ service: value, ...codesOf(profile?.services.find((s) => s.id === value)) });
  }

  function chooseActivity(value: string) {
    const a = activities.find((x) => `${x.c_trib_nac}|${x.c_trib_mun}` === value);
    if (!a) return;
    const name = a.servico_nome ?? tables?.TRIB_NACIONAL[a.c_trib_nac] ?? "";
    patch({ customNac: a.c_trib_nac, customMun: a.c_trib_mun, customName: name.slice(0, 300), munOther: false, ...codesOf(null), nbs: a.c_nbs ?? "" });
  }

  /** Códigos municipais já vistos com este código nacional: os da própria empresa primeiro, depois os do escritório. */
  function knownMunicipal(nac: string): { code: string; hint: string }[] {
    if (nac.length !== 6) return [];
    const out = new Map<string, string>();
    // a nota traz o nome municipal da atividade só às vezes; quando repete o nome nacional, não ajuda a escolher
    const named = (name: string | null | undefined, hint: string) => {
      const own = name && !/^\d+$/.test(name) && name.toLowerCase() !== (tables?.TRIB_NACIONAL[nac] ?? "").toLowerCase() ? name : "";
      return [own, hint].filter(Boolean).join(" · ");
    };
    for (const s of profile?.services ?? []) {
      const [n, m] = s.id.split("|");
      if (n === nac && m) out.set(m, named(s.nome === s.codigo ? "" : s.nome, `já usado por esta empresa (${s.notas} nota${s.notas === 1 ? "" : "s"})`));
    }
    for (const a of activities) {
      if (a.c_trib_nac === nac && a.c_trib_mun && !out.has(a.c_trib_mun)) out.set(a.c_trib_mun, named(a.servico_nome, "já usado em notas do escritório"));
    }
    return [...out].map(([code, hint]) => ({ code, hint }));
  }

  function chooseNational(nac: string) {
    const known = knownMunicipal(nac);
    // o NBS sugerido é o da última nota do escritório com este código, quando há
    const nbs = activities.find((a) => a.c_trib_nac === nac && a.c_nbs)?.c_nbs ?? "";
    patch({ customNac: nac, customName: (tables?.TRIB_NACIONAL[nac] ?? "").slice(0, 300), customMun: known.length === 1 ? known[0].code : "", munOther: false, ...codesOf(null), nbs });
  }

  /** IBS/CBS vai inteiro ou não vai: sem classificação, saem também a situação tributária e o indicador. */
  function chooseClassTrib(value: string, nac: string) {
    if (!value) return patch({ classTrib: "", cst: "", indOp: "" });
    patch({ classTrib: value, cst: cstOf(value), indOp: draft?.indOp || (tables ? onlyIndOp(tables, nac, onlyDigits(draft?.nbs ?? "")) : "") });
  }

  function lookup() {
    if (!draft) return;
    startLookup(async () => {
      const res = await lookupTaker(draft.newTaker.doc);
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "CNPJ não encontrado." : res.error);
        return;
      }
      const d = res.data;
      patch({ newTaker: { doc: d.doc, nome: d.nome, cmun: d.cmun || "2211001", cidade: d.cidade, cep: d.cep, logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro } });
      setTakerStatus(d.situacao || null);
      setTakerEdit(false);
      if (d.situacao && d.situacao.toUpperCase() !== "ATIVA") toast.warning(`Situação do CNPJ na Receita: ${d.situacao}.`);
    });
  }

  const taker = draft?.takerKind === "known" ? (profile?.takers.find((t) => t.doc === draft.takerDoc) ?? null) : null;
  const custom = draft?.service === CUSTOM;
  const customId = draft && custom ? `${onlyDigits(draft.customNac)}|${onlyDigits(draft.customMun)}` : "";
  /** código nacional da atividade em uso: o do serviço escolhido ou o da "outra atividade" */
  const nac = draft ? (custom ? onlyDigits(draft.customNac) : (draft.service.split("|")[0] ?? "")) : "";
  /** códigos digitados em vez das listas: a pessoa pediu ou as tabelas não carregaram */
  const typing = Boolean(draft?.typed) || tablesFailed;
  const nbsCode = draft ? onlyDigits(draft.nbs) : "";
  const classCode = draft ? onlyDigits(draft.classTrib) : "";
  const indCode = draft ? onlyDigits(draft.indOp) : "";
  const munCode = draft ? onlyDigits(draft.customMun) : "";
  const munKnown = custom ? knownMunicipal(nac) : [];
  const munTyped = Boolean(draft?.munOther) || !munKnown.length || Boolean(munCode && !munKnown.some((m) => m.code === munCode));
  const service =
    draft && custom
      ? { id: customId, codigo: formatServiceCode(customId), nome: draft.customName.trim() || "Atividade informada à mão", notas: 0, livre: true, nbs: "", ibs: null }
      : (profile?.services.find((s) => s.id === draft?.service) ?? null);
  const amount = draft ? parseAmount(draft.amount) : null;
  const check = draft ? checkDraft(amount, custom ? customId : draft.service, taker, draft.takerKind === "new") : null;
  const takerDocForModel = draft?.takerKind === "known" ? draft.takerDoc : draft?.takerKind === "new" ? draft.newTaker.doc.replace(/\D/g, "") : null;
  const model = draft && notes ? (custom ? pickBaseModel(notes) : draft.service ? pickModel(notes, draft.service, takerDocForModel || null) : null) : null;
  const codeLine = (nbs?: string | null, classTrib?: string | null) => [nbs ? `NBS ${formatNbs(nbs)}` : "", classTrib ? `cClassTrib ${classTrib}` : ""].filter(Boolean).join(" · ");
  const missing: string[] = [];
  if (draft) {
    if (draft.takerKind === "known" && !taker) missing.push("Escolha o tomador.");
    missing.push(...checkCodes({ custom, nac: draft.customNac, mun: draft.customMun, nbs: draft.nbs, cst: draft.cst, classTrib: draft.classTrib, indOp: draft.indOp, lists: !typing }));
    if (draft.takerKind === "new") {
      const t = draft.newTaker;
      if (![11, 14].includes(t.doc.replace(/\D/g, "").length) || !t.nome.trim() || t.cep.replace(/\D/g, "").length !== 8 || !t.logradouro.trim() || !t.numero.trim() || !t.bairro.trim()) {
        missing.push("Complete os dados do tomador novo.");
      }
    }
    if (!amount) missing.push("Informe o valor.");
    if (draft.description.trim().length < 3) missing.push("Escreva a descrição do serviço.");
    if (model && !model.ok) missing.push(model.error);
  }
  const ready = Boolean(draft && client && canRun && client.certificate_ok && missing.length === 0 && model?.ok);

  function emit() {
    if (!draft || !client || !notes || !model?.ok || !amount) return;
    const payload = {
      client_id: client.id,
      test_env: isOwner && testEnv ? true : undefined,
      source: draft.source,
      request_text: draft.source === "ai" ? request : undefined,
      model_chave: model.chave,
      toma_chave: draft.takerKind === "known" ? takerNoteKey(notes, draft.takerDoc) : null,
      toma: draft.takerKind === "new" ? { ...draft.newTaker, doc: draft.newTaker.doc.replace(/\D/g, ""), cep: draft.newTaker.cep.replace(/\D/g, "") } : null,
      description: draft.description.trim(),
      amount,
      ...(custom ? { custom_service: true, c_trib_nac: onlyDigits(draft.customNac), c_trib_mun: onlyDigits(draft.customMun), servico_nome: draft.customName.trim() || undefined } : {}),
      c_nbs: onlyDigits(draft.nbs),
      ibs: { cst: onlyDigits(draft.cst), class_trib: onlyDigits(draft.classTrib), ind_op: onlyDigits(draft.indOp) },
    };
    startSend(async () => {
      const res = await createEmission(payload);
      setConfirming(false);
      if (!res.ok || !res.data) {
        toast.error(res.ok ? "Não foi possível registrar o pedido." : res.error);
        return;
      }
      const created = res.data;
      setEmissions((prev) => (prev.some((e) => e.id === created.id) ? prev : [created, ...prev]));
      setActiveId(created.id);
      toast.success("Pedido enviado ao robô.");
    });
  }

  function confirmCancel() {
    if (!canceling) return;
    const target = canceling;
    startSend(async () => {
      const res = await cancelEmission({ id: target.id, reasonCode: cancelCode, reason: cancelReason });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCanceling(null);
      setCancelReason("");
      setEmissions((prev) => prev.map((e) => (e.id === target.id ? { ...e, cancel_status: "requested" } : e)));
      toast.success("Cancelamento enviado ao robô.");
    });
  }

  function recheck(emission: Emission) {
    const jobId = emission.status === "issued" ? emission.cancel_job_id : emission.job_id;
    if (!jobId) return;
    startSend(async () => {
      const res = await retryJob(jobId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setEmissions((prev) => prev.map((e) => (e.id === emission.id ? (emission.status === "issued" ? { ...e, cancel_status: "requested" } : { ...e, status: "queued", errors: [] }) : e)));
      setActiveId(emission.id);
      toast.success("O robô vai conferir na prefeitura antes de qualquer novo envio.");
    });
  }

  /** `inline`: o próprio botão mostra "Aviso copiado" (aba Emitir); sem ele, avisa pelo toast. */
  async function copyNotice(emission: Emission, inline = false) {
    try {
      await navigator.clipboard.writeText(clientNotice(emission));
      if (inline) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } else toast.success("Aviso copiado: é só colar no WhatsApp do cliente.");
    } catch {
      toast.error("Não foi possível copiar.");
    }
  }

  const term = listQuery.trim().toLowerCase();
  const listed = emissions.filter((e) => {
    const s = emissionState(e);
    if (listFilter === "issued" && e.status !== "issued") return false;
    if (listFilter === "canceled" && e.status !== "canceled") return false;
    if (listFilter === "problem" && !(e.status === "rejected" || e.status === "failed" || s.uncertain)) return false;
    if (!term) return true;
    return `${clientName.get(e.client_id) ?? ""} ${e.toma_nome ?? ""} ${e.numero ?? ""} ${e.description}`.toLowerCase().includes(term);
  });
  function pickTaker(value: string) {
    chooseTaker(value);
    setTakerOpen(false);
    setTakerFilter("");
  }

  function pickCompany(id: string) {
    setCompanyOpen(false);
    chooseClient(id);
  }

  function pickService(value: string) {
    chooseService(value);
    setServiceOpen(false);
  }

  // empresas: busca por nome, código ou CNPJ (com ou sem pontuação)
  const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const companyTerm = fold(companyQuery.trim());
  const companyDigits = companyTerm.replace(/\D/g, "");
  const companyRows = clients.filter(
    (c) => !companyTerm || fold(`${c.name} ${c.client_code}`).includes(companyTerm) || (companyDigits.length >= 3 && c.cnpj.replace(/\D/g, "").includes(companyDigits)),
  );

  const takerListOpen = Boolean(draft) && (takerOpen || (draft?.takerKind === "known" && !taker));
  // dúvidas da leitura do pedido: as do valor ficam embaixo do valor; as demais, embaixo do tomador
  const valueDoubts = (draft?.doubts ?? []).filter((d) => /\bvalor\b/i.test(d));
  const otherDoubts = (draft?.doubts ?? []).filter((d) => !/\bvalor\b/i.test(d));
  const nt = draft?.newTaker;
  const newTakerAddress = nt
    ? [nt.logradouro.trim() ? `${nt.logradouro.trim()}${nt.numero.trim() ? `, ${nt.numero.trim()}` : ""}` : "", nt.bairro.trim(), nt.cidade, nt.cep.replace(/\D/g, "").replace(/^(\d{5})(\d{3})$/, "$1-$2")]
        .filter(Boolean)
        .join(" · ")
    : "";

  const codesLine = [nbsCode ? `NBS ${formatNbs(nbsCode)}` : "", classCode ? `cClassTrib ${classCode}` : "", indCode ? `Ind. ${indCode}` : ""].filter(Boolean).join(" · ") || "sem NBS e IBS/CBS";
  const offTable = Boolean(
    tables && nac.length === 6 && ((nbsCode && !nbsOptions(tables, nac).some((o) => o.value === nbsCode)) || (classCode && !tables.CLASS_TRIB[classCode]) || (indCode && !tables.IND_OP[indCode])),
  );
  const codeIssues = draft ? checkCodes({ custom: false, nac: "", mun: "", nbs: draft.nbs, cst: draft.cst, classTrib: draft.classTrib, indOp: draft.indOp, lists: !typing }).length > 0 : false;
  const codesShown = codesOpen ?? (custom || offTable || codeIssues);

  // a nota de onde saem o imposto e a retenção (o painel não guarda a alíquota: só sabe de qual nota ela vem)
  const modelNote = model?.ok && notes ? (notes.find((n) => n.chave === model.chave) ?? null) : null;
  const valueChanged = check?.amountDiff !== null && check?.amountDiff !== undefined;
  const problems: { text: string; red?: boolean }[] = [];
  if (draft && !active) {
    if (client && !client.certificate_ok) problems.push({ text: "Sem certificado válido: renove o certificado da empresa", red: true });
    if (robot.state === "offline") problems.push({ text: "Robô desligado: a nota fica na fila e sai quando ele ligar" });
    for (const text of new Set([...(check?.warnings ?? []), ...missing])) problems.push({ text });
  }
  const allClear = ready && problems.length === 0;

  const shownTakers = (profile?.takers ?? []).filter((t) => !takerFilter.trim() || `${t.nome} ${t.doc}`.toLowerCase().includes(takerFilter.trim().toLowerCase())).slice(0, 300);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-[9px] bg-(--c-ecece8) p-[3px] text-[13px]">
          {(["emit", "list"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn("rounded-[7px] px-3.5 py-1 font-medium text-(--c-6b6c66)", tab === t && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]")}
            >
              {t === "emit" ? "Emitir" : `Emitidas${emissions.length ? ` (${emissions.length})` : ""}`}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2 text-[12.5px] text-(--c-6b6c66)">
          <span>
            No mês: <b className="text-foreground">{summary.issued}</b> emitida(s) · <b className="text-foreground">{formatBRL(summary.issuedTotal)}</b>
          </span>
          {summary.canceled ? <span>· {summary.canceled} cancelada(s)</span> : null}
          {summary.refused ? <span>· {summary.refused} não emitida(s)</span> : null}
        </div>
      </div>

      {tab === "emit" ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,1fr)]">
          <section className="min-w-0 overflow-clip rounded-xl border bg-card shadow-card">
            {/* 1. empresa */}
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <h3 className={STEP_TITLE}>
                <StepDot n={1} done={Boolean(client)} />
                Empresa
              </h3>
              {client ? (
                <>
                  <div className="-mt-1 ml-7 flex items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[14px] font-semibold">{client.name}</span>
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-(--c-6b6c66)">
                        <span className="font-mono">{formatDoc(client.cnpj)}</span>
                        <span>
                          {client.notas} nota{client.notas === 1 ? "" : "s"} no histórico
                        </span>
                        {client.certificate_ok ? (
                          <span className="flex items-center gap-1 text-(--c-1c7a47)">
                            <ShieldCheck className="size-[13px]" /> Certificado válido
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-(--c-b45309)">
                            <TriangleAlert className="size-[13px]" /> Sem certificado válido
                          </span>
                        )}
                      </span>
                    </div>
                    {active ? null : (
                      <button type="button" className={LINK} onClick={() => chooseClient("")}>
                        Trocar
                      </button>
                    )}
                  </div>
                  {isOwner ? (
                    <label className="ml-7 flex cursor-pointer items-center gap-1.5 text-[12px] text-(--c-6b6c66)">
                      <input type="checkbox" checked={testEnv} onChange={(e) => setTestEnv(e.target.checked)} />
                      <FlaskConical className="size-3.5" /> Ambiente de teste da prefeitura (sem valor fiscal)
                    </label>
                  ) : null}
                </>
              ) : (
                <>
                  <Popover
                    open={companyOpen}
                    onOpenChange={(open) => {
                      setCompanyOpen(open);
                      if (open) setCompanyQuery("");
                    }}
                  >
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        disabled={!canRun}
                        className="flex h-9 w-full items-center gap-2 rounded-[7px] border border-(--c-e3e3df) bg-card px-3 text-left text-[13px] outline-none transition-colors hover:bg-(--c-fafaf8) focus:border-ring disabled:cursor-not-allowed disabled:bg-(--c-f5f5f2)"
                      >
                        <span className="min-w-0 flex-1 truncate text-(--c-6b6c66)">Escolha a empresa</span>
                        <ChevronDown className="size-3.5 shrink-0 text-(--c-6b6c66)" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" collisionPadding={8} className="w-(--radix-popover-trigger-width) max-w-[94vw] min-w-[300px] gap-0 overflow-clip rounded-[10px] p-0">
                      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-(--c-efefeb) px-3">
                        <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
                        <input
                          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--c-6b6c66)"
                          placeholder="Buscar pelo nome, código ou CNPJ"
                          aria-label="Buscar empresa"
                          value={companyQuery}
                          onChange={(e) => setCompanyQuery(e.target.value)}
                          onKeyDown={(e) => {
                            // Enter escolhe a primeira empresa da lista que pode emitir
                            const first = e.key === "Enter" ? companyRows.find((c) => c.certificate_ok) : undefined;
                            if (first) pickCompany(first.id);
                          }}
                        />
                      </div>
                      <div className="thin-scrollbar max-h-[min(472px,calc(var(--radix-popover-content-available-height)-40px))] overflow-y-auto">
                        {companyRows.map((c) => {
                          const left = (
                            <span className="flex min-w-0 flex-col gap-px">
                              <span className="truncate text-[13px] font-medium">{c.name}</span>
                              <span className="font-mono text-[11.5px] text-(--c-6b6c66)">
                                {c.client_code} · {formatDoc(c.cnpj)}
                              </span>
                            </span>
                          );
                          return c.certificate_ok ? (
                            <button key={c.id} type="button" onClick={() => pickCompany(c.id)} className={cn(ROW, "py-2.5 last:border-b-0")}>
                              {left}
                              <span className="text-[12px] whitespace-nowrap text-(--c-6b6c66)">
                                <span className="font-mono text-foreground">{c.notas}</span> nota{c.notas === 1 ? "" : "s"}
                              </span>
                            </button>
                          ) : (
                            // sem certificado válido a nota não sai: a linha não seleciona, só leva à renovação
                            <div key={c.id} className="grid cursor-default grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-(--c-f2f2ef) px-3 py-2.5 opacity-75">
                              {left}
                              <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap text-(--c-b45309)">
                                <Lock className="size-3" /> sem certificado válido
                                <Link href="/certificates" className="font-medium text-primary">
                                  Renovar →
                                </Link>
                              </span>
                            </div>
                          );
                        })}
                        {companyRows.length === 0 ? <p className="p-4 text-center text-[13px] text-(--c-6b6c66)">Nenhuma empresa encontrada.</p> : null}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <p className="text-[12px] text-(--c-6b6c66)">
                    Só aparecem empresas com ao menos uma nota que sirva de modelo.{canRun ? "" : " Seu perfil só visualiza."}
                  </p>
                </>
              )}

              {loadingNotes ? (
                <p className="flex items-center gap-2 text-[12.5px] text-(--c-6b6c66)">
                  <Loader2 className="size-3.5 animate-spin" /> Lendo o histórico de notas da empresa…
                </p>
              ) : null}

              {client && profile && profile.usable === 0 ? (
                <Notice tone="amber" icon={<TriangleAlert />}>
                  <b>Esta empresa ainda não tem nota que sirva de modelo.</b>{" "}
                  {profile.blocked ? `Motivo: ${profile.blocked}.` : "Busque as NFS-e dela primeiro, em NFS-e Nacional."}
                </Notice>
              ) : null}
            </div>

            {/* 2. pedido */}
            {client && profile && profile.usable > 0 ? (
              <div className="flex flex-col gap-3 border-t border-(--c-efefeb) px-4 py-3.5">
                <h3 className={STEP_TITLE}>
                  <StepDot n={2} done={Boolean(draft)} />
                  Pedido
                </h3>
                {draft ? (
                  <div className="-mt-1 ml-7 flex items-start gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center gap-1.5 text-[12px] text-(--c-6b6c66)">
                        {draft.source === "ai" ? (
                          <>
                            <Sparkles className="size-[13px]" /> Pedido lido pela IA
                          </>
                        ) : draft.source === "repeat" ? (
                          <>
                            <Repeat2 className="size-[13px]" /> Repetindo a {draft.origin.replace(/^da\s+/, "") || "nota"}
                          </>
                        ) : (
                          <>
                            <PenLine className="size-[13px]" /> Preenchendo à mão
                          </>
                        )}
                      </span>
                      {draft.source === "ai" && request.trim() ? (
                        <span className="self-start rounded-[4px_12px_12px_12px] border border-(--c-dcefe3) bg-(--c-f3faf6) px-[11px] py-1.5 text-[13px] leading-[1.45] break-words">
                          {request.trim()}
                        </span>
                      ) : null}
                    </div>
                    {active ? null : (
                      <button type="button" className={LINK} onClick={() => setDraft(null)}>
                        Refazer
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {(
                        [
                          ["ai", Sparkles, "Colar o pedido"],
                          ["repeat", Repeat2, "Repetir uma nota"],
                          ["manual", PenLine, "Preencher à mão"],
                        ] as const
                      ).map(([key, Icon, title]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setMode(key);
                            if (key === "manual") openDraft({ source: "manual", origin: "" });
                          }}
                          className={cn(
                            "flex h-8 items-center gap-[7px] rounded-[7px] border px-3 text-[13px] whitespace-nowrap transition-colors",
                            mode === key ? "border-(--c-9fd3b5) bg-(--c-eef7f1) font-medium text-(--c-17603b)" : "border-(--c-e3e3df) bg-card text-(--c-4a4b46) hover:bg-(--c-fafaf8)",
                          )}
                        >
                          <Icon className="size-3.5" /> {title}
                        </button>
                      ))}
                    </div>

                    {mode === "ai" ? (
                      aiReady ? (
                        <div className="flex flex-col gap-2.5">
                          <textarea
                            className={cn(AREA, "min-h-[72px] rounded-[4px_12px_12px_12px] border-(--c-cfe8d9) bg-(--c-f3faf6)")}
                            value={request}
                            onChange={(e) => setRequest(e.target.value)}
                            placeholder="Cole aqui a mensagem do cliente. Ex.: faz uma nota de 1.500 para o Condomínio Sol, manutenção do ar do salão"
                            maxLength={1500}
                          />
                          <div className="flex flex-wrap items-center gap-2.5">
                            <button type="button" className={BTN_PRIMARY} onClick={read} disabled={reading || request.trim().length < 4}>
                              {reading ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Ler o pedido
                            </button>
                            <span className="text-[12px] text-(--c-6b6c66)">A IA lê o texto. Serviço e imposto vêm da última nota aceita.</span>
                          </div>
                        </div>
                      ) : (
                        <Notice tone="blue" icon={<Sparkles />}>
                          A leitura por IA ainda não está configurada neste painel. Use “Repetir uma nota” ou “Preencher à mão”.
                        </Notice>
                      )
                    ) : null}

                    {mode === "repeat" ? (
                      <ul className="overflow-clip rounded-[10px] border border-(--c-e6e6e1)">
                        {profile.recent.map((n) => (
                          <li key={n.chave} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-(--c-f2f2ef) px-3 py-2.5 last:border-b-0 hover:bg-(--c-fafaf8)">
                            <span className="flex min-w-0 flex-col gap-px">
                              <span className="truncate text-[13px] font-medium">{n.tomador ?? "Sem tomador identificado"}</span>
                              <span className="truncate text-[11.5px] text-(--c-6b6c66)">
                                <span className="font-mono">
                                  nº {n.numero ?? "—"} · {formatDate(n.data)}
                                </span>{" "}
                                · {n.descricao}
                              </span>
                            </span>
                            <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums">{formatBRL(n.valor)}</span>
                            <button type="button" className={cn(BTN_OUTLINE, "h-7 px-2.5 text-xs")} onClick={() => repeat(n)}>
                              Usar
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {/* 3. campos */}
            {draft && profile ? (
              <div className={cn("flex flex-col gap-3.5 border-t border-(--c-efefeb) py-3.5 pr-4 pb-[18px] pl-11", active && "pointer-events-none opacity-60")} inert={Boolean(active)}>
                <h3 className={cn(STEP_TITLE, "-ml-7")}>
                  <StepDot n={3} done={false} />
                  Confira os campos
                  {active ? (
                    <span className="ml-auto flex items-center gap-1.5 text-[12px] font-normal text-(--c-6b6c66)">
                      <Lock className="size-3" /> travado enquanto está com o robô
                    </span>
                  ) : null}
                </h3>

                <Group
                  label="Tomador"
                  tag={
                    taker ? (
                      <Origin icon={History}>
                        do histórico · {taker.notas} nota{taker.notas === 1 ? "" : "s"}
                      </Origin>
                    ) : draft.takerKind === "new" ? (
                      <Tag tone="amber">tomador novo</Tag>
                    ) : null
                  }
                >
                  {takerListOpen ? (
                    <div className="overflow-clip rounded-[9px] border border-(--c-9fd3b5) shadow-[0_0_0_3px_rgba(31,122,77,0.10)]">
                      <div className="flex h-9 items-center gap-2 border-b border-(--c-efefeb) px-3">
                        <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
                        <input
                          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--c-6b6c66)"
                          placeholder="Filtrar pelo nome ou CNPJ"
                          aria-label="Filtrar tomadores"
                          value={takerFilter}
                          onChange={(e) => setTakerFilter(e.target.value)}
                        />
                      </div>
                      <div className="thin-scrollbar max-h-[300px] overflow-y-auto">
                        {shownTakers.map((t) => (
                          <button
                            key={t.doc}
                            type="button"
                            onClick={() => pickTaker(t.doc)}
                            className={cn(ROW, "py-2", draft.takerKind === "known" && t.doc === draft.takerDoc && "bg-(--c-f3faf6)")}
                          >
                            <span className="flex min-w-0 flex-col gap-px">
                              <span className="truncate text-[13px] font-medium">{t.nome}</span>
                              <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{formatDoc(t.doc)}</span>
                            </span>
                            <span className="text-[11.5px] whitespace-nowrap text-(--c-6b6c66)">
                              {t.notas} nota{t.notas === 1 ? "" : "s"} · última {formatDate(t.ultima.data)}
                            </span>
                          </button>
                        ))}
                        {shownTakers.length === 0 && takerFilter.trim() ? (
                          <p className="border-b border-(--c-f2f2ef) px-3 py-2.5 text-[12.5px] text-(--c-6b6c66)">Nenhum tomador com esse texto.</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => pickTaker("__new")}
                        className="flex w-full items-center gap-2 border-b border-(--c-f2f2ef) px-3 py-2.5 text-left text-[13px] font-medium text-primary transition-colors hover:bg-(--c-fafaf8)"
                      >
                        <Plus className="size-3.5" /> Novo tomador (busca pelo CNPJ)
                      </button>
                      <button
                        type="button"
                        onClick={() => pickTaker("__none")}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-(--c-4a4b46) transition-colors hover:bg-(--c-fafaf8)"
                      >
                        <UserX className="size-3.5 text-(--c-6b6c66)" /> Sem tomador identificado
                      </button>
                    </div>
                  ) : draft.takerKind === "new" ? (
                    <div className="flex flex-col gap-2 rounded-[9px] border border-(--c-e6e6e1) bg-(--c-fafaf8) px-3 py-2.5">
                      <div className="flex gap-2">
                        <input
                          className={cn(INPUT, "min-w-0 flex-1 font-mono")}
                          inputMode="numeric"
                          placeholder="CNPJ ou CPF"
                          aria-label="CNPJ ou CPF do tomador"
                          value={draft.newTaker.doc}
                          onChange={(e) => {
                            setTakerStatus(null);
                            patch({ newTaker: { ...draft.newTaker, doc: e.target.value } });
                          }}
                        />
                        <button type="button" className={BTN_OUTLINE} onClick={lookup} disabled={looking || draft.newTaker.doc.replace(/\D/g, "").length !== 14}>
                          {looking ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />} Buscar dados
                        </button>
                        <button type="button" className="px-1.5 text-[12.5px] whitespace-nowrap text-(--c-6b6c66) hover:text-foreground" onClick={() => setTakerOpen(true)}>
                          Voltar
                        </button>
                      </div>
                      {takerEdit ? (
                        <>
                          <Field label="Nome / razão social">
                            <input className={INPUT} value={draft.newTaker.nome} onChange={(e) => patch({ newTaker: { ...draft.newTaker, nome: e.target.value } })} />
                          </Field>
                          <div className="grid gap-2.5 sm:grid-cols-[2fr_1fr_1.3fr]">
                            <Field label="Logradouro">
                              <input className={INPUT} value={draft.newTaker.logradouro} onChange={(e) => patch({ newTaker: { ...draft.newTaker, logradouro: e.target.value } })} />
                            </Field>
                            <Field label="Número">
                              <input className={INPUT} value={draft.newTaker.numero} onChange={(e) => patch({ newTaker: { ...draft.newTaker, numero: e.target.value } })} />
                            </Field>
                            <Field label="Bairro">
                              <input className={INPUT} value={draft.newTaker.bairro} onChange={(e) => patch({ newTaker: { ...draft.newTaker, bairro: e.target.value } })} />
                            </Field>
                          </div>
                          <div className="grid gap-2.5 sm:grid-cols-3">
                            <Field label="CEP">
                              <input className={INPUT} inputMode="numeric" value={draft.newTaker.cep} onChange={(e) => patch({ newTaker: { ...draft.newTaker, cep: e.target.value } })} />
                            </Field>
                            <Field label="Código IBGE do município">
                              <input
                                className={INPUT}
                                inputMode="numeric"
                                value={draft.newTaker.cmun}
                                onChange={(e) => patch({ newTaker: { ...draft.newTaker, cmun: e.target.value.replace(/\D/g, "").slice(0, 7), cidade: "" } })}
                              />
                            </Field>
                            <Field label="Cidade">
                              <input className={INPUT} value={draft.newTaker.cidade || "—"} disabled />
                            </Field>
                          </div>
                          <button type="button" className={cn(LINK, "self-start")} onClick={() => setTakerEdit(false)}>
                            Fechar a edição
                          </button>
                        </>
                      ) : draft.newTaker.nome.trim() ? (
                        <div className="flex flex-col gap-px text-[12.5px]">
                          <b className="font-semibold">{draft.newTaker.nome}</b>
                          <span className="text-(--c-6b6c66)">{newTakerAddress || "Endereço ainda não informado: use Buscar dados ou Editar dados."}</span>
                          {takerStatus ? (
                            takerStatus.toUpperCase() === "ATIVA" ? (
                              <span className="text-(--c-1c7a47)">Ativa na Receita Federal</span>
                            ) : (
                              <span className="text-(--c-9a6205)">Situação na Receita Federal: {takerStatus}</span>
                            )
                          ) : null}
                          <button type="button" className={cn(LINK, "mt-0.5 self-start")} onClick={() => setTakerEdit(true)}>
                            Editar dados
                          </button>
                        </div>
                      ) : (
                        <span className="text-[12px] text-(--c-6b6c66)">
                          Nome e endereço vêm da Receita Federal.{" "}
                          <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setTakerEdit(true)}>
                            Preencher à mão
                          </button>
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-[9px] border border-(--c-e3e3df) px-3 py-2.5">
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="truncate text-[13.5px] font-medium">{taker ? taker.nome : "Sem tomador identificado"}</span>
                        {taker ? <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{formatDoc(taker.doc)}</span> : null}
                      </div>
                      <button type="button" className={LINK} onClick={() => setTakerOpen(true)}>
                        Trocar
                      </button>
                    </div>
                  )}
                  {otherDoubts.map((d) => (
                    <Doubt key={d}>{d}</Doubt>
                  ))}
                </Group>

                <Group
                  label="Serviço"
                  tag={
                    custom ? (
                      <Tag tone="amber">outra atividade</Tag>
                    ) : service ? (
                      <Origin icon={History}>
                        do histórico · {service.notas} nota{service.notas === 1 ? "" : "s"}
                      </Origin>
                    ) : null
                  }
                >
                  <div className="overflow-clip rounded-[9px] border border-(--c-e3e3df)">
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="text-[13.5px] font-medium">{service?.nome ?? "Escolha o serviço"}</span>
                        {service?.codigo ? <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{service.codigo}</span> : null}
                      </div>
                      <button type="button" className={LINK} onClick={() => setServiceOpen((open) => !open)} aria-expanded={serviceOpen}>
                        {serviceOpen ? "Fechar" : "Trocar"}
                      </button>
                    </div>

                    {serviceOpen ? (
                      <>
                        {profile.services.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => pickService(s.id)}
                            className={cn(
                              "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-(--c-f2f2ef) px-3 py-2 text-left transition-colors hover:bg-(--c-fafaf8)",
                              s.id === draft.service && "bg-(--c-f3faf6)",
                            )}
                          >
                            <span className="flex min-w-0 flex-col gap-px">
                              <span className="text-[13px] font-medium">{s.nome}</span>
                              <span className="font-mono text-[11.5px] text-(--c-6b6c66)">
                                {s.codigo}
                                {s.livre ? "" : " · só para tomador que já tem nota com ele"}
                              </span>
                            </span>
                            <span className="text-[11.5px] whitespace-nowrap text-(--c-6b6c66)">
                              {s.notas} nota{s.notas === 1 ? "" : "s"}
                            </span>
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => pickService(CUSTOM)}
                          className={cn(
                            "flex w-full items-center gap-2 border-t border-(--c-f2f2ef) px-3 py-2.5 text-left text-[13px] text-(--c-4a4b46) transition-colors hover:bg-(--c-fafaf8)",
                            custom && "bg-(--c-f3faf6)",
                          )}
                        >
                          <ListPlus className="size-3.5 text-(--c-6b6c66)" /> Outra atividade do cadastro (pelo código nacional)
                        </button>
                      </>
                    ) : null}

                    {custom ? (
                      <div className="flex flex-col gap-2.5 border-t border-(--c-efefeb) bg-(--c-fafaf8) p-3">
                        {activities.length ? (
                          <Field label="Atividades já usadas nas notas do escritório (opcional: preenche os códigos)">
                            <select className={INPUT} value="" onChange={(e) => chooseActivity(e.target.value)}>
                              <option value="">— escolher da lista —</option>
                              {activities.map((a) => (
                                <option key={`${a.c_trib_nac}|${a.c_trib_mun}`} value={`${a.c_trib_nac}|${a.c_trib_mun}`}>
                                  {a.servico_nome ?? tables?.TRIB_NACIONAL[a.c_trib_nac] ?? "Atividade"} — {formatServiceCode(`${a.c_trib_nac}|${a.c_trib_mun}`)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : null}
                        <Field label="Código de tributação nacional">
                          {typing ? (
                            <input className={INPUT} inputMode="numeric" placeholder="6 números. Ex.: 14.06.01" value={draft.customNac} onChange={(e) => patch({ customNac: e.target.value })} maxLength={10} />
                          ) : (
                            <SearchSelect
                              label="Código de tributação nacional"
                              value={nac}
                              options={nationalList}
                              onChange={chooseNational}
                              placeholder={tables ? "Buscar pelo número ou pelo nome do serviço" : "Carregando as listas…"}
                              disabled={!tables}
                            />
                          )}
                        </Field>
                        <Group
                          label="Código complementar municipal (3 números)"
                          tag={
                            munKnown.length && munTyped ? (
                              <button type="button" className="text-[11px] font-medium text-foreground underline underline-offset-2" onClick={() => patch({ munOther: false, customMun: "" })}>
                                escolher entre os já usados
                              </button>
                            ) : null
                          }
                        >
                          {munTyped ? (
                            <input className={INPUT} inputMode="numeric" placeholder="Ex.: 009" aria-label="Código complementar municipal" value={draft.customMun} onChange={(e) => patch({ customMun: e.target.value })} maxLength={3} />
                          ) : (
                            <select
                              className={INPUT}
                              aria-label="Código complementar municipal"
                              value={munCode}
                              onChange={(e) => (e.target.value === "__other" ? patch({ munOther: true, customMun: "" }) : patch({ customMun: e.target.value }))}
                            >
                              <option value="">— escolher —</option>
                              {munKnown.map((m) => (
                                <option key={m.code} value={m.code}>
                                  {formatServiceCode(`${nac}|${m.code}`)} — {m.hint}
                                </option>
                              ))}
                              <option value="__other">Outro código do cadastro da empresa (digitar)</option>
                            </select>
                          )}
                        </Group>
                      </div>
                    ) : null}

                    <div className="flex items-center gap-2.5 border-t border-dashed border-(--c-e3e3df) bg-(--c-fafaf8) px-3 py-2">
                      <span className="text-[12px] whitespace-nowrap text-(--c-6b6c66)">Códigos fiscais</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-(--c-4a4b46)" title={codesLine}>
                        {codesLine}
                      </span>
                      <button type="button" className="flex items-center gap-1 text-[12px] font-medium whitespace-nowrap" onClick={() => setCodesOpen(!codesShown)} aria-expanded={codesShown}>
                        {codesShown ? "Fechar" : "Alterar"}
                        {codesShown ? <ChevronUp className="size-[13px] text-(--c-6b6c66)" /> : <ChevronDown className="size-[13px] text-(--c-6b6c66)" />}
                      </button>
                    </div>

                    {codesShown ? (
                      <div className="grid gap-2.5 border-t border-(--c-efefeb) p-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
                        {typing ? (
                          <>
                            <Field label="Item NBS">
                              <input className={INPUT} inputMode="numeric" placeholder="9 números" value={draft.nbs} onChange={(e) => patch({ nbs: e.target.value })} maxLength={12} />
                            </Field>
                            <Field label="Classificação tributária (IBS/CBS)">
                              <input className={INPUT} inputMode="numeric" placeholder="cClassTrib, 6 números" value={draft.classTrib} onChange={(e) => patch({ classTrib: e.target.value })} maxLength={6} />
                            </Field>
                            <Field label="Situação tributária (CST)">
                              <input className={INPUT} inputMode="numeric" placeholder="3 números" value={draft.cst} onChange={(e) => patch({ cst: e.target.value })} maxLength={3} />
                            </Field>
                            <Field label="Indicador da operação">
                              <input className={INPUT} inputMode="numeric" placeholder="6 números" value={draft.indOp} onChange={(e) => patch({ indOp: e.target.value })} maxLength={6} />
                            </Field>
                          </>
                        ) : (
                          <>
                            <Field label="Item NBS" tag={!custom && service?.nbs && nbsCode === service.nbs ? <Origin icon={History}>da última nota</Origin> : null}>
                              <SearchSelect
                                label="Item NBS"
                                value={nbsCode}
                                options={tables ? withCurrent(nbsOptions(tables, nac), nbsCode, `${nbsLabel(tables, nbsCode)} (fora da tabela oficial para este serviço)`) : []}
                                onChange={(value) => patch({ nbs: value })}
                                placeholder={!tables ? "Carregando as listas…" : nac.length === 6 ? "Sem NBS" : "Escolha antes a atividade"}
                                emptyLabel="— sem NBS —"
                                disabled={!tables || nac.length !== 6}
                              />
                            </Field>
                            <Field
                              label="Classificação tributária (IBS/CBS)"
                              tag={service?.ibs && classCode === service.ibs.classTrib ? <Origin icon={History}>da última nota</Origin> : null}
                            >
                              <SearchSelect
                                label="Classificação tributária"
                                value={classCode}
                                options={tables ? withCurrent(classTribOptions(tables, nac, nbsCode), classCode, `${classTribLabel(tables, classCode)} (fora da tabela oficial)`) : []}
                                onChange={(value) => chooseClassTrib(value, nac)}
                                placeholder={!tables ? "Carregando as listas…" : nac.length === 6 ? "Não informar IBS/CBS" : "Escolha antes a atividade"}
                                emptyLabel="— não informar IBS/CBS —"
                                disabled={!tables || nac.length !== 6}
                              />
                            </Field>
                            <Field label="Situação tributária (CST)">
                              <input className={INPUT} value={draft.cst ? cstLabel(tables, onlyDigits(draft.cst)) : "—"} title={draft.cst ? cstLabel(tables, onlyDigits(draft.cst)) : undefined} disabled />
                            </Field>
                            <Field label="Indicador da operação">
                              <SearchSelect
                                label="Indicador da operação"
                                value={indCode}
                                options={tables ? withCurrent(indOpOptions(tables, nac, nbsCode), indCode, `${indOpLabel(tables, indCode)} (fora da tabela oficial)`) : []}
                                onChange={(value) => patch({ indOp: value })}
                                placeholder={classCode ? "Escolher o indicador" : "Escolha antes a classificação"}
                                disabled={!tables || !classCode}
                              />
                            </Field>
                          </>
                        )}
                        <p className="col-span-full text-[12px] leading-[1.45] text-(--c-6b6c66)">
                          Opcionais. Vazios, a nota sai sem eles. Os valores do IBS/CBS quem calcula é a prefeitura.{" "}
                          {tablesFailed ? null : (
                            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => patch({ typed: !draft.typed })}>
                              {draft.typed ? "Voltar para as listas" : "Digitar os códigos"}
                            </button>
                          )}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </Group>

                <Field
                  label="Descrição na nota"
                  tag={draft.origin ? <Origin icon={draft.source === "ai" ? Sparkles : Repeat2}>{draft.origin}</Origin> : null}
                >
                  <textarea className={cn(AREA, "min-h-[62px]")} value={draft.description} onChange={(e) => patch({ description: e.target.value })} maxLength={2000} />
                </Field>

                <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                  <div className="flex flex-col gap-1.5">
                    <Field label="Valor">
                      <span className="flex h-9 items-center gap-1.5 rounded-[7px] border border-(--c-e3e3df) bg-card px-2.5 transition-colors focus-within:border-ring">
                        <span className="text-[13px] text-(--c-6b6c66)">R$</span>
                        <input
                          className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-(--c-9a9b94)"
                          inputMode="decimal"
                          placeholder="0,00"
                          value={draft.amount}
                          onChange={(e) => patch({ amount: e.target.value })}
                        />
                      </span>
                    </Field>
                    {valueDoubts.map((d) => (
                      <Doubt key={d}>{d}</Doubt>
                    ))}
                  </div>
                  <Field label="Competência">
                    <span className="flex h-9 items-center rounded-[7px] border border-(--c-e3e3df) bg-(--c-f5f5f2) px-2.5 font-mono text-[14px] font-medium text-(--c-6b6c66)">
                      {month.slice(5)}/{month.slice(0, 4)}
                    </span>
                  </Field>
                </div>
              </div>
            ) : null}
          </section>

          {/* prévia */}
          <section className="overflow-clip rounded-xl border bg-card shadow-card lg:sticky lg:top-20">
            <header className="flex items-center gap-2 border-b border-(--c-efefeb) px-4 py-3 text-[13.5px] font-semibold">
              Prévia da nota
              {activeState ? (
                <span className="ml-auto">
                  <ToneBadge tone={activeState.tone}>{activeState.label}</ToneBadge>
                </span>
              ) : null}
            </header>
            <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
              {!draft && !active ? (
                <div className="flex flex-col items-center gap-2 rounded-[10px] border border-dashed border-(--c-d9d9d4) px-4 py-7 text-center">
                  <span className="grid size-9 place-items-center rounded-full bg-(--c-f5f5f2) text-(--c-6b6c66)">
                    <ReceiptText className="size-[17px]" />
                  </span>
                  <span className="max-w-[260px] text-[13px] leading-[1.45] text-(--c-4a4b46)">
                    {client ? "Cole o pedido do cliente ou repita uma nota. A prévia se preenche sozinha." : "Escolha a empresa para começar."}
                  </span>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-[10px] border border-(--c-d9d9d4)">
                  <div className="flex items-center gap-2 border-b border-(--c-e3e3df) bg-(--c-f5f5f1) px-3 py-[7px] text-[11px] font-semibold tracking-[0.04em] text-(--c-6b6c66) uppercase">
                    NFS-e · Teresina
                    <span className="ml-auto font-medium tracking-normal normal-case">
                      competência{" "}
                      <span className="font-mono">
                        {month.slice(5)}/{month.slice(0, 4)}
                      </span>
                    </span>
                  </div>
                  {active?.numero ? (
                    <span
                      className={cn(
                        "absolute top-[42px] right-2.5 rotate-6 rounded-md border-2 bg-card/85 px-2 py-0.5 text-[11px] font-bold tracking-[0.06em]",
                        active.status === "canceled" ? "border-(--c-9a9b94) text-(--c-6b6c66)" : "border-primary text-primary",
                      )}
                    >
                      {active.status === "canceled" ? "CANCELADA" : "EMITIDA"} · Nº {active.numero}
                    </span>
                  ) : null}
                  <dl className="px-3 py-0.5 text-[13px]">
                    {(
                      [
                        ["Prestador", client ? <b key="p">{client.name}</b> : null, client ? formatDoc(client.cnpj) : "", null],
                        [
                          "Tomador",
                          active ? (
                            <b key="t">{active.toma_nome ?? "Sem tomador identificado"}</b>
                          ) : taker ? (
                            <b key="t">{taker.nome}</b>
                          ) : draft?.takerKind === "new" && draft.newTaker.nome ? (
                            <b key="t">{draft.newTaker.nome}</b>
                          ) : draft?.takerKind === "none" ? (
                            "Sem tomador identificado"
                          ) : null,
                          active ? formatDoc(active.toma_doc) : taker ? formatDoc(taker.doc) : draft?.takerKind === "new" ? formatDoc(draft.newTaker.doc.replace(/\D/g, "")) : "",
                          null,
                        ],
                        [
                          "Serviço",
                          active ? <b key="s">{active.servico_nome}</b> : service ? <b key="s">{service.nome}</b> : null,
                          active
                            ? [formatServiceCode(`${active.c_trib_nac}|${active.c_trib_mun}`), codeLine(active.c_nbs, active.ibs_class_trib)].filter(Boolean).join(" · ")
                            : [service?.codigo ?? "", draft ? codeLine(onlyDigits(draft.nbs), onlyDigits(draft.classTrib)) : ""].filter(Boolean).join(" · "),
                          // a comparação com a última nota do tomador fica dentro do cartão
                          !active && taker && service ? (
                            <Tag key="d" tone={check?.serviceChanged ? "amber" : "green"}>
                              {check?.serviceChanged ? "mudou desde a" : "igual à"} nº {taker.ultima.numero ?? "—"}
                            </Tag>
                          ) : null,
                        ],
                        ["Descrição", active ? active.description : draft?.description || null, "", null],
                      ] as const
                    ).map(([label, value, sub, extra]) => (
                      <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 border-b border-dashed border-(--c-e8e8e4) py-2 last:border-b-0">
                        <dt className="pt-px text-[11.5px] text-(--c-6b6c66)">{label}</dt>
                        <dd className="flex min-w-0 flex-col items-start gap-0.5 leading-[1.4] [overflow-wrap:anywhere]">
                          {value ? <span>{value}</span> : <span className="text-(--c-9a9b94) italic">—</span>}
                          {sub ? <span className="font-mono text-[11.5px] text-(--c-6b6c66)">{sub}</span> : null}
                          {extra}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-col gap-1.5 border-t border-(--c-e3e3df) bg-(--c-fafaf8) px-3 py-2.5">
                    {!active && modelNote ? (
                      <div className="text-[12px] text-(--c-6b6c66)">ISS e retenção como na nota nº {modelNote.numero ?? "—"}</div>
                    ) : null}
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[12px] text-(--c-6b6c66)">Valor da nota</span>
                      <b className="text-[22px] font-semibold tracking-[-0.02em] tabular-nums">{formatBRL(active ? active.amount : (amount ?? 0))}</b>
                    </div>
                    {!active && taker && amount ? (
                      <div className="flex items-center justify-end gap-1.5 text-[12px] text-(--c-6b6c66)">
                        <span>última para este tomador</span>
                        <span className={cn("tabular-nums", valueChanged && "line-through")}>{formatBRL(taker.ultima.valor)}</span>
                        {valueChanged ? (
                          <Tag tone="amber">
                            {(check?.amountDiff ?? 0) > 0 ? "+" : ""}
                            {check?.amountDiff}%
                          </Tag>
                        ) : (
                          <Tag tone="green">igual</Tag>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {/* antes de emitir: conferência */}
              {draft && !active ? (
                <>
                  {allClear ? (
                    <div
                      className="flex items-center gap-2 text-[12.5px] text-(--c-1c5e3c)"
                      title="Certificado da empresa válido · Robô ligado no computador do escritório · Serviço já aceito pela prefeitura para esta empresa"
                    >
                      <CircleCheck className="size-3.5 shrink-0 text-primary" />
                      <span>
                        Pronta para emitir <span className="text-(--c-6b6c66)">· certificado, robô e serviço conferidos</span>
                      </span>
                    </div>
                  ) : problems.length ? (
                    <ul className="flex flex-col gap-1.5 text-[12.5px]">
                      {problems.map((p) => (
                        <li key={p.text} className={cn("flex items-start gap-2", p.red ? "text-(--c-b42323)" : "text-(--c-9a6205)")}>
                          <TriangleAlert className="mt-px size-3.5 shrink-0" /> {p.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button type="button" className={cn(BTN_PRIMARY, "h-10 w-full rounded-lg text-[14px]")} disabled={!ready} onClick={() => setConfirming(true)}>
                    <Send className="size-[15px]" /> Emitir nota{isOwner && testEnv ? " de teste" : ""}
                  </button>
                  <p className="-mt-1.5 text-center text-[12px] text-(--c-6b6c66)">{canRun ? "A nota só sai depois da sua confirmação." : "Seu perfil só visualiza."}</p>
                </>
              ) : null}

              {/* depois de pedir: andamento e resultado */}
              {active && activeState ? (
                <>
                  <Timeline emission={active} />
                  {activeState.running ? (
                    <p className="text-[12px] leading-[1.45] text-(--c-6b6c66)">
                      Pode sair desta tela. O andamento continua em{" "}
                      <button type="button" className="font-medium text-primary hover:underline" onClick={() => setTab("list")}>
                        Emitidas
                      </button>
                      .
                    </p>
                  ) : null}
                  {active.test_env ? (
                    <Notice tone="amber" icon={<FlaskConical />}>
                      Nota do ambiente de teste da prefeitura: sem valor fiscal.
                    </Notice>
                  ) : null}
                  {active.status === "rejected" || (active.status === "failed" && !activeState.uncertain) ? (
                    <Notice tone="red" icon={<TriangleAlert />}>
                      <b className="mb-1 block">{active.status === "rejected" ? "A prefeitura recusou a nota. Nada foi emitido." : "A nota não foi emitida."}</b>
                      <Rejections emission={active} />
                    </Notice>
                  ) : null}
                  {activeState.uncertain ? (
                    <Notice tone="amber" icon={<TriangleAlert />}>
                      <b className="block">O robô enviou a nota, mas não conseguiu confirmar a resposta da prefeitura.</b>
                      Antes de emitir de novo, confira: o robô pergunta à prefeitura se a nota saiu e não envia nada em dobro.
                      <button type="button" className={cn(BTN_OUTLINE, "mt-2")} onClick={() => recheck(active)} disabled={sending || !canRun}>
                        <RotateCw className="size-3.5" /> Conferir na prefeitura
                      </button>
                    </Notice>
                  ) : null}
                  {active.status === "issued" && active.cancel_status === "rejected" ? (
                    <Notice tone="red" icon={<TriangleAlert />}>
                      <b className="mb-1 block">O cancelamento não foi aceito. A nota continua emitida.</b>
                      <Rejections emission={{ ...active, errors: active.cancel_errors }} />
                    </Notice>
                  ) : null}
                  {active.status === "issued" || active.status === "canceled" ? (
                    <div className="flex flex-col gap-2">
                      <div className={cn("grid gap-2", active.status === "issued" && "grid-cols-2")}>
                        <button type="button" className={cn(BTN_PRIMARY, "h-9 rounded-lg")} onClick={() => void openDanfse(active)}>
                          <FileText className="size-3.5" /> Ver o DANFSE
                        </button>
                        {active.status === "issued" ? (
                          <button type="button" className={cn(BTN_OUTLINE, "h-9 rounded-lg")} onClick={() => void copyNotice(active, true)}>
                            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Aviso copiado" : "Copiar aviso"}
                          </button>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3.5 text-[12.5px]">
                        <button type="button" className="flex items-center gap-1.5 text-(--c-4a4b46) hover:text-foreground" onClick={() => void downloadXml(active)}>
                          <Download className="size-[13px]" /> XML
                        </button>
                        {active.status === "issued" && canRun && !activeState.running ? (
                          <button type="button" className="text-(--c-b42323) hover:underline" onClick={() => setCanceling(active)}>
                            Cancelar a nota
                          </button>
                        ) : null}
                        {!active.test_env ? <span className="ml-auto text-(--c-6b6c66)">também em Downloads</span> : null}
                      </div>
                    </div>
                  ) : null}
                  {!activeState.running ? (
                    <button
                      type="button"
                      className={cn(BTN_OUTLINE, "h-9 w-full rounded-lg")}
                      onClick={() => {
                        setActiveId(null);
                        if (active.status === "issued" || active.status === "canceled") setDraft(null);
                      }}
                    >
                      {active.status === "issued" || active.status === "canceled" ? (
                        <>
                          <Plus className="size-3.5" /> Emitir outra nota
                        </>
                      ) : (
                        <>
                          <PenLine className="size-3.5" /> Voltar e corrigir
                        </>
                      )}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : (
        <section className="overflow-clip rounded-xl border bg-card shadow-card">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-(--c-efefeb) px-3.5 py-3">
            <div className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-[7px] border border-input px-2.5 focus-within:border-ring sm:max-w-[320px]">
              <Search className="size-3.5 shrink-0 text-(--c-6b6c66)" />
              <input className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--c-6b6c66)" placeholder="Buscar por empresa, tomador ou número" value={listQuery} onChange={(e) => setListQuery(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["all", "Todas"],
                  ["issued", "Emitidas"],
                  ["canceled", "Canceladas"],
                  ["problem", "Com problema"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setListFilter(key)}
                  className={cn("rounded-full border border-(--c-d9d9d4) px-2.5 py-0.5 text-xs text-(--c-6b6c66)", listFilter === key && "border-foreground bg-foreground text-background")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {listed.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-(--c-6b6c66)">Nenhuma nota emitida pelo sistema{term || listFilter !== "all" ? " com esse filtro" : " ainda"}.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="bg-(--c-fafaf8) text-left text-[11px] tracking-[0.05em] text-(--c-6b6c66) uppercase">
                    <th className="px-3.5 py-2 font-medium">Nº</th>
                    <th className="px-3.5 py-2 font-medium">Pedido</th>
                    <th className="hidden px-3.5 py-2 font-medium md:table-cell">Empresa</th>
                    <th className="px-3.5 py-2 font-medium">Tomador</th>
                    <th className="px-3.5 py-2 text-right font-medium">Valor</th>
                    <th className="px-3.5 py-2 font-medium">Situação</th>
                    <th className="hidden px-3.5 py-2 font-medium lg:table-cell">Emitida por</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((e) => {
                    const s = emissionState(e);
                    return (
                      <tr key={e.id} className="cursor-pointer border-t border-(--c-efefeb) hover:bg-(--c-fafaf8)" onClick={() => setDetail(e)}>
                        <td className="px-3.5 py-2 font-semibold tabular-nums">{e.numero ?? "—"}</td>
                        <td className="px-3.5 py-2 whitespace-nowrap tabular-nums">{formatDateTime(e.created_at)}</td>
                        <td className="hidden px-3.5 py-2 md:table-cell">{clientName.get(e.client_id) ?? "—"}</td>
                        <td className="max-w-[280px] px-3.5 py-2">
                          <span className="block truncate">{e.toma_nome ?? "Sem tomador identificado"}</span>
                          <span className="block truncate text-[11.5px] text-(--c-6b6c66)">{e.description}</span>
                        </td>
                        <td className="px-3.5 py-2 text-right whitespace-nowrap tabular-nums">{formatBRL(e.amount)}</td>
                        <td className="px-3.5 py-2">
                          <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
                          {e.test_env ? <span className="mt-0.5 block text-[11px] text-(--c-9a6205)">ambiente de teste</span> : null}
                        </td>
                        <td className="hidden px-3.5 py-2 lg:table-cell">{(e.created_by && userNames[e.created_by]) || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-(--c-efefeb) px-3.5 py-2 text-[12px] text-(--c-6b6c66)">
            Clique numa nota para ver o histórico dela. As notas baixadas pelo robô ficam em <Link href="/downloads?type=nfse" className="text-primary hover:underline">Downloads</Link>.
          </p>
        </section>
      )}

      {/* confirmar a emissão */}
      <Dialog open={confirming} onOpenChange={(open) => !sending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Emitir esta nota{isOwner && testEnv ? " de teste" : ""}?</DialogTitle>
            <DialogDescription>
              {isOwner && testEnv
                ? "Vai para o ambiente de teste da prefeitura: não tem valor fiscal."
                : "É uma nota fiscal de verdade, em nome da empresa. Depois de emitida, só dá para cancelar."}
            </DialogDescription>
          </DialogHeader>
          <dl className="rounded-[9px] border border-(--c-e6e6e1) px-3 py-1 text-[13px]">
            {(
              [
                ["Empresa", client?.name ?? ""],
                ["Tomador", taker ? `${taker.nome} — ${formatDoc(taker.doc)}` : draft?.takerKind === "new" ? `${draft.newTaker.nome} — ${formatDoc(draft.newTaker.doc.replace(/\D/g, ""))} (novo)` : "Sem tomador identificado"],
                ["Serviço", service ? [`${service.nome} (${service.codigo})`, draft ? codeLine(onlyDigits(draft.nbs), onlyDigits(draft.classTrib)) : ""].filter(Boolean).join(" · ") : ""],
                ["Descrição", draft?.description ?? ""],
                ["Valor", formatBRL(amount ?? 0)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="grid grid-cols-[76px_1fr] gap-2 border-b border-dashed border-(--c-e8e8e4) py-1.5 last:border-b-0">
                <dt className="text-[12px] text-(--c-6b6c66)">{label}</dt>
                <dd className={cn("min-w-0 break-words", label === "Valor" && "text-[15px] font-semibold")}>{value}</dd>
              </div>
            ))}
          </dl>
          <DialogFooter>
            <button type="button" className={BTN_OUTLINE} onClick={() => setConfirming(false)} disabled={sending}>
              Voltar
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={emit} disabled={sending}>
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Emitir nota
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* cancelar */}
      <Dialog open={canceling !== null} onOpenChange={(open) => !open && !sending && setCanceling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar a nota nº {canceling?.numero}?</DialogTitle>
            <DialogDescription>O cancelamento vai para a prefeitura. Se ela aceitar, a nota fica marcada como cancelada.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field label="Motivo">
              <select className={INPUT} value={cancelCode} onChange={(e) => setCancelCode(Number(e.target.value) as 1 | 2 | 9)}>
                {CANCEL_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Explique em uma linha (a prefeitura exige ao menos 15 letras)">
              <input className={INPUT} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={255} placeholder="Ex.: valor combinado foi alterado pelo cliente" />
            </Field>
          </div>
          <DialogFooter>
            <button type="button" className={BTN_OUTLINE} onClick={() => setCanceling(null)} disabled={sending}>
              Voltar
            </button>
            <button type="button" className={BTN_DANGER} onClick={confirmCancel} disabled={sending || cancelReason.trim().length < 15}>
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : null} Cancelar a nota
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* histórico de uma nota */}
      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-[430px]">
          {detail
            ? (() => {
                const current = emissions.find((e) => e.id === detail.id) ?? detail;
                const s = emissionState(current);
                return (
                  <>
                    <SheetHeader>
                      <SheetTitle>{current.numero ? `Nota nº ${current.numero}` : "Nota não emitida"}</SheetTitle>
                      <SheetDescription>
                        {clientName.get(current.client_id) ?? ""} · {formatBRL(current.amount)} · pedida em {formatDateTime(current.created_at)}
                        {current.created_by && userNames[current.created_by] ? ` por ${userNames[current.created_by]}` : ""}
                      </SheetDescription>
                    </SheetHeader>
                    <div className="flex flex-col gap-3.5 px-4 pb-6 text-[13px]">
                      <ToneBadge tone={s.tone} className="self-start">
                        {s.label}
                      </ToneBadge>
                      {current.request_text ? (
                        <div>
                          <span className="text-[12px] text-(--c-6b6c66)">Pedido original do cliente</span>
                          <p className="mt-1 rounded-[4px_12px_12px_12px] border border-(--c-cfe8d9) bg-(--c-f3faf6) px-3 py-2">{current.request_text}</p>
                        </div>
                      ) : null}
                      <dl className="rounded-[9px] border border-(--c-e6e6e1) px-3 py-1">
                        {(
                          [
                            ["Tomador", `${current.toma_nome ?? "Sem tomador identificado"}${current.toma_doc ? ` — ${formatDoc(current.toma_doc)}` : ""}`],
                            ["Serviço", [`${current.servico_nome ?? ""} (${formatServiceCode(`${current.c_trib_nac}|${current.c_trib_mun}`)})`, codeLine(current.c_nbs, current.ibs_class_trib)].filter(Boolean).join(" · ")],
                            ["Descrição", current.description],
                            ["Origem", current.source === "ai" ? "pedido lido pela IA" : current.source === "repeat" ? "nota repetida" : "preenchida à mão"],
                            ...(current.chave ? ([["Chave", current.chave]] as const) : []),
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label} className="grid grid-cols-[70px_1fr] gap-2 border-b border-dashed border-(--c-e8e8e4) py-1.5 last:border-b-0">
                            <dt className="text-[12px] text-(--c-6b6c66)">{label}</dt>
                            <dd className="min-w-0 break-all">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <Timeline emission={current} />
                      {current.status === "rejected" || current.status === "failed" ? (
                        <Notice tone={s.uncertain ? "amber" : "red"} icon={<TriangleAlert />}>
                          {s.uncertain ? <b className="mb-1 block">Envio sem confirmação da prefeitura: confira antes de emitir de novo.</b> : null}
                          <Rejections emission={current} />
                        </Notice>
                      ) : null}
                      {current.status === "canceled" && current.cancel_reason ? <p className="text-(--c-6b6c66)">Cancelada em {formatDateTime(current.canceled_at)}: {current.cancel_reason}</p> : null}
                      {current.status === "issued" && current.cancel_status === "rejected" ? (
                        <Notice tone="red" icon={<TriangleAlert />}>
                          <b className="mb-1 block">O cancelamento não foi aceito.</b>
                          <Rejections emission={{ ...current, errors: current.cancel_errors }} />
                        </Notice>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {current.status === "issued" || current.status === "canceled" ? (
                          <>
                            <button type="button" className={BTN_PRIMARY} onClick={() => void openDanfse(current)}>
                              <FileText className="size-3.5" /> DANFSE
                            </button>
                            <button type="button" className={BTN_OUTLINE} onClick={() => void downloadXml(current)}>
                              <Download className="size-3.5" /> XML
                            </button>
                          </>
                        ) : null}
                        {current.status === "issued" ? (
                          <button type="button" className={BTN_OUTLINE} onClick={() => void copyNotice(current)}>
                            <Copy className="size-3.5" /> Copiar aviso
                          </button>
                        ) : null}
                        {s.uncertain && canRun ? (
                          <button type="button" className={BTN_OUTLINE} onClick={() => recheck(current)} disabled={sending}>
                            <RotateCw className="size-3.5" /> Conferir na prefeitura
                          </button>
                        ) : null}
                        {current.status === "issued" && canRun && !s.running ? (
                          <button
                            type="button"
                            className={BTN_DANGER}
                            onClick={() => {
                              setDetail(null);
                              setCanceling(current);
                            }}
                          >
                            Cancelar a nota
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </>
                );
              })()
            : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
