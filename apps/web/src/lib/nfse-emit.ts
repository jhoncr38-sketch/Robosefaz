// Emissão de NFS-e: o que a tela tira das notas já baixadas do cliente (tomadores, serviços e a
// nota-modelo) e como mostrar cada emissão. Nada aqui decide imposto: o serviço e a tributação saem
// sempre de uma nota real que a prefeitura já aceitou; a tela só escolhe qual e avisa o que mudou.

import { MUNICIPIOS } from "./ibge-municipios.ts";
import type { Tone } from "./status.ts";

/** Linha do índice (tabela notes) de uma NFS-e prestada do cliente. */
export interface EmitNote {
  chave: string;
  numero: number | null;
  emitida_em: string | null;
  valor: number | string | null;
  dest_doc: string | null;
  dest_nome: string | null;
  /** descrição do serviço escrita na nota */
  servico: string | null;
  c_trib_nac: string | null;
  c_trib_mun: string | null;
  /** nome do código de serviço (municipal ou nacional) */
  servico_nome: string | null;
  /** "ok", "mesmo_tomador" ou o motivo de a nota não servir de modelo (avaliado pelo robô) */
  emit_model: string | null;
  canceled?: boolean | null;
  c_nbs?: string | null;
  /** códigos de IBS/CBS da nota, quando ela tem */
  ibs_cst?: string | null;
  ibs_class_trib?: string | null;
  ibs_ind_op?: string | null;
}

/** Códigos de IBS/CBS que a nota leva (os valores quem calcula é a prefeitura). */
export interface IbsCodes {
  cst: string;
  classTrib: string;
  indOp: string;
}

export interface EmitNoteRef {
  chave: string;
  numero: number | null;
  data: string | null;
  valor: number;
  descricao: string;
  /** código nacional|municipal */
  servico: string;
  servicoNome: string;
  tomadorDoc: string | null;
  tomador: string | null;
  nbs: string;
  ibs: IbsCodes | null;
}

export interface EmitTaker {
  doc: string;
  nome: string;
  notas: number;
  ultima: EmitNoteRef;
}

export interface EmitService {
  id: string;
  codigo: string;
  nome: string;
  notas: number;
  /** há nota deste serviço que serve de modelo para qualquer tomador */
  livre: boolean;
  /** NBS e IBS/CBS da nota mais recente deste serviço (o que a tela sugere) */
  nbs: string;
  ibs: IbsCodes | null;
}

/** Atividade já usada nas notas do escritório (sugestão para "Outra atividade"). */
export interface EmitActivity {
  c_trib_nac: string;
  c_trib_mun: string;
  c_nbs: string | null;
  servico_nome: string | null;
  notas: number;
}

export interface EmitProfile {
  takers: EmitTaker[];
  services: EmitService[];
  recent: EmitNoteRef[];
  /** notas que servem de modelo */
  usable: number;
  /** motivo mais comum de as demais não servirem (para explicar uma lista vazia) */
  blocked: string | null;
}

export const MODEL_BLOCK_REASON: Record<string, string> = {
  sem_dps: "as notas não trazem a DPS de origem",
  outro_municipio: "as notas não foram emitidas por Teresina",
  emissor_nacional: "as notas foram emitidas pelo emissor nacional (caso do MEI), não pela prefeitura",
  fora_simples: "a empresa está fora do Simples Nacional (ME/EPP)",
  ibs_cbs: "as notas têm o grupo de IBS/CBS",
  valores_de_imposto: "as notas têm valores de imposto ou retenção que precisariam ser recalculados",
  desconto_ou_deducao: "as notas têm desconto ou dedução",
  intermediario: "as notas têm intermediário",
  emitente_nao_prestador: "as notas não foram emitidas pelo próprio prestador",
  nao_tributavel: "a operação não é tributável normalmente",
  servico_especial: "o serviço tem dados próprios (evento, locação, comércio exterior ou pedágio)",
};

/** Colunas do índice (notes) que a tela usa. */
export const EMIT_NOTE_COLUMNS =
  "chave, numero, emitida_em, valor, dest_doc, dest_nome, servico, c_trib_nac, c_trib_mun, servico_nome, emit_model, canceled, c_nbs, ibs_cst, ibs_class_trib, ibs_ind_op";

/** Colunas de nfse_emissions para a tela: sem o XML da nota (vem só quando alguém abre o DANFSe). */
export const EMISSION_COLUMNS =
  "id, client_id, created_by, created_at, test_env, source, request_text, toma_doc, toma_nome, c_trib_nac, c_trib_mun, servico_nome, description, amount, competence, status, job_id, n_dps, send_started_at, chave, numero, issued_at, errors, last_message, steps, cancel_status, cancel_job_id, cancel_reason, cancel_errors, canceled_at, custom_service, c_nbs, ibs_cst, ibs_class_trib, ibs_ind_op";

/** A emissão ainda está em teste. Enquanto for false, a aba aparece no menu com cadeado para todos os
 *  escritórios e só o dono da plataforma entra (para testar). No lançamento vira true, e aí vale o
 *  liga/desliga de cada escritório. */
export const NFSE_EMIT_RELEASED: boolean = false;

/** "on": usa a emissão. "testing": é o dono da plataforma, que entra antes do lançamento. "locked": vê o cadeado. */
export type EmitAccess = "on" | "testing" | "locked";

export function emitAccess(o: { released: boolean; officeEnabled: boolean; isOwner: boolean }): EmitAccess {
  // depois do lançamento o dono sempre entra: é nessa tela que ele liga a função para cada escritório
  if (o.released && (o.officeEnabled || o.isOwner)) return "on";
  return o.isOwner ? "testing" : "locked";
}

const USABLE = new Set(["ok", "mesmo_tomador"]);

export function serviceId(n: Pick<EmitNote, "c_trib_nac" | "c_trib_mun">): string {
  return `${n.c_trib_nac ?? ""}|${n.c_trib_mun ?? ""}`;
}

/** "140101|040" -> "14.01.01 / 040" */
export function formatServiceCode(id: string): string {
  const [nac, mun] = id.split("|");
  const n = nac && nac.length === 6 ? `${nac.slice(0, 2)}.${nac.slice(2, 4)}.${nac.slice(4)}` : (nac ?? "");
  return [n, mun].filter(Boolean).join(" / ");
}

function usable(n: EmitNote): boolean {
  return USABLE.has(n.emit_model ?? "") && Boolean(n.c_trib_nac) && Boolean(n.c_trib_mun) && !n.canceled;
}

function byDateDesc(a: EmitNote, b: EmitNote): number {
  return (b.emitida_em ?? "").localeCompare(a.emitida_em ?? "");
}

function ibsOf(n: EmitNote): IbsCodes | null {
  return n.ibs_cst && n.ibs_class_trib && n.ibs_ind_op ? { cst: n.ibs_cst, classTrib: n.ibs_class_trib, indOp: n.ibs_ind_op } : null;
}

function ref(n: EmitNote): EmitNoteRef {
  return {
    chave: n.chave,
    numero: n.numero,
    data: n.emitida_em,
    valor: Number(n.valor ?? 0),
    descricao: n.servico ?? "",
    servico: serviceId(n),
    servicoNome: n.servico_nome ?? "",
    tomadorDoc: n.dest_doc,
    tomador: n.dest_nome,
    nbs: n.c_nbs ?? "",
    ibs: ibsOf(n),
  };
}

/** Tomadores, serviços e últimas notas do cliente, a partir das NFS-e prestadas que servem de modelo. */
export function buildEmitProfile(notes: EmitNote[]): EmitProfile {
  const sorted = [...notes].sort(byDateDesc);
  const good = sorted.filter(usable);
  const takers = new Map<string, EmitTaker>();
  const services = new Map<string, EmitService>();
  for (const n of good) {
    const id = serviceId(n);
    // as notas vêm da mais recente para a mais antiga: o NBS e o IBS/CBS sugeridos são os da mais recente
    const s = services.get(id) ?? { id, codigo: formatServiceCode(id), nome: n.servico_nome ?? formatServiceCode(id), notas: 0, livre: false, nbs: n.c_nbs ?? "", ibs: ibsOf(n) };
    s.notas += 1;
    s.livre ||= n.emit_model === "ok";
    services.set(id, s);
    if (n.dest_doc) {
      const t = takers.get(n.dest_doc) ?? { doc: n.dest_doc, nome: n.dest_nome ?? n.dest_doc, notas: 0, ultima: ref(n) };
      t.notas += 1;
      takers.set(n.dest_doc, t);
    }
  }
  const reasons = new Map<string, number>();
  for (const n of sorted) {
    if (!usable(n) && n.emit_model && !USABLE.has(n.emit_model)) reasons.set(n.emit_model, (reasons.get(n.emit_model) ?? 0) + 1);
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    takers: [...takers.values()].sort((a, b) => b.notas - a.notas || a.nome.localeCompare(b.nome, "pt-BR")),
    services: [...services.values()].sort((a, b) => b.notas - a.notas),
    recent: good.slice(0, 12).map(ref),
    usable: good.length,
    blocked: top ? (MODEL_BLOCK_REASON[top] ?? top) : null,
  };
}

export type ModelChoice = { ok: true; chave: string; sameTaker: boolean } | { ok: false; error: string };

/** A nota-modelo para este serviço e tomador: a mais recente do mesmo tomador; senão, a mais recente
 *  que vale para qualquer tomador. Obra e ISS retido só se repetem para o mesmo tomador. */
export function pickModel(notes: EmitNote[], service: string, takerDoc: string | null): ModelChoice {
  const candidates = notes.filter((n) => usable(n) && serviceId(n) === service).sort(byDateDesc);
  if (!candidates.length) return { ok: false, error: "Escolha um serviço que a empresa já emitiu." };
  const same = takerDoc ? candidates.find((n) => n.dest_doc === takerDoc) : undefined;
  if (same) return { ok: true, chave: same.chave, sameTaker: true };
  const free = candidates.find((n) => n.emit_model === "ok");
  if (free) return { ok: true, chave: free.chave, sameTaker: false };
  return {
    ok: false,
    error: "Este serviço leva dados de obra ou ISS retido: só dá para repetir para um tomador que já tem nota com ele.",
  };
}

/** Outra atividade do cadastro da empresa (informada à mão): a base é a nota comum mais recente, de onde
 *  saem o cadastro do prestador e a tributação; só os códigos da atividade mudam. */
export function pickBaseModel(notes: EmitNote[]): ModelChoice {
  const base = notes.filter((n) => usable(n) && n.emit_model === "ok").sort(byDateDesc)[0];
  if (base) return { ok: true, chave: base.chave, sameTaker: false };
  return { ok: false, error: "Para informar outra atividade, a empresa precisa de ao menos uma nota comum (sem obra nem ISS retido) no histórico." };
}

/** O que falta ou está errado nos códigos (atividade, NBS e IBS/CBS). `lists`: a pessoa escolhe nas listas
 *  oficiais em vez de digitar, e o aviso fala em escolher. */
export function checkCodes(c: { custom: boolean; nac: string; mun: string; nbs: string; cst: string; classTrib: string; indOp: string; lists?: boolean }): string[] {
  const d = (v: string) => v.replace(/\D/g, "");
  const out: string[] = [];
  if (c.custom && (d(c.nac).length !== 6 || d(c.mun).length !== 3)) {
    out.push(c.lists ? "Atividade: escolha o código de tributação nacional e o complementar municipal (3 números)." : "Atividade: informe o código nacional (6 números) e o municipal (3 números).");
  }
  if (d(c.nbs) && d(c.nbs).length !== 9) out.push("O código NBS tem 9 números.");
  const ibs = [d(c.cst), d(c.classTrib), d(c.indOp)];
  if (ibs.some(Boolean) && !(ibs[0].length === 3 && ibs[1].length === 6 && ibs[2].length === 6)) {
    out.push(
      c.lists
        ? "IBS/CBS: escolha também o indicador da operação, ou deixe a classificação tributária sem informar."
        : "IBS/CBS: informe o CST (3 números), o cClassTrib (6) e o indicador da operação (6), ou deixe os três vazios.",
    );
  }
  return out;
}

/** "101061200" -> "1.0106.12.00" */
export function formatNbs(code: string | null | undefined): string {
  const c = String(code ?? "");
  return /^\d{9}$/.test(c) ? `${c[0]}.${c.slice(1, 5)}.${c.slice(5, 7)}.${c.slice(7)}` : c;
}

/** A nota de onde o robô copia os dados do tomador (a mais recente dele). */
export function takerNoteKey(notes: EmitNote[], takerDoc: string): string | null {
  return [...notes].filter((n) => n.dest_doc === takerDoc && !n.canceled).sort(byDateDesc)[0]?.chave ?? null;
}

/** "1.500,00", "1500", "R$ 1.500" -> 1500; inválido -> null */
export function parseAmount(text: string): number | null {
  let t = String(text ?? "").replace(/[^\d.,]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function formatBRL(value: number | string | null | undefined): string {
  return Number(value ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatAmountInput(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface DraftCheck {
  /** diferença em % para a última nota do tomador (null: igual, sem nota anterior ou sem valor) */
  amountDiff: number | null;
  serviceChanged: boolean;
  warnings: string[];
}

/** O que mudou em relação à última nota para o mesmo tomador. */
export function checkDraft(amount: number | null, service: string, taker: EmitTaker | null, newTaker: boolean): DraftCheck {
  const warnings: string[] = [];
  let amountDiff: number | null = null;
  let serviceChanged = false;
  if (taker) {
    const last = taker.ultima;
    if (amount !== null && last.valor > 0 && Math.abs(amount - last.valor) > 0.004) {
      amountDiff = Math.round(((amount - last.valor) / last.valor) * 100);
      warnings.push(`Valor ${Math.abs(amountDiff)}% ${amount > last.valor ? "maior" : "menor"} que o da última nota para este tomador.`);
    }
    if (service && service !== last.servico) {
      serviceChanged = true;
      warnings.push("Serviço diferente do da última nota para este tomador.");
    }
  } else if (newTaker) {
    warnings.push("Tomador novo: confira o CNPJ e o endereço com atenção.");
  }
  return { amountDiff, serviceChanged, warnings };
}

/** Faixas de CEP por estado (Correios): os 5 primeiros números, de–até. */
const CEP_RANGES: [number, number, string][] = [
  [1000, 19999, "SP"], [20000, 28999, "RJ"], [29000, 29999, "ES"], [30000, 39999, "MG"], [40000, 48999, "BA"],
  [49000, 49999, "SE"], [50000, 56999, "PE"], [57000, 57999, "AL"], [58000, 58999, "PB"], [59000, 59999, "RN"],
  [60000, 63999, "CE"], [64000, 64999, "PI"], [65000, 65999, "MA"], [66000, 68899, "PA"], [68900, 68999, "AP"],
  [69000, 69299, "AM"], [69300, 69399, "RR"], [69400, 69899, "AM"], [69900, 69999, "AC"], [70000, 72799, "DF"],
  [72800, 72999, "GO"], [73000, 73699, "DF"], [73700, 76799, "GO"], [76800, 76999, "RO"], [77000, 77999, "TO"],
  [78000, 78899, "MT"], [79000, 79999, "MS"], [80000, 87999, "PR"], [88000, 89999, "SC"], [90000, 99999, "RS"],
];

/** Estado a que o CEP pertence ("PE"); vazio se o CEP está incompleto. */
export function cepUf(cep: string): string {
  const d = cep.replace(/\D/g, "");
  if (d.length !== 8) return "";
  const n = Number(d.slice(0, 5));
  return CEP_RANGES.find(([from, to]) => n >= from && n <= to)?.[2] ?? "";
}

/** CEP de um estado e município de outro: a prefeitura recusa a nota (E0240). O aviso sai antes de enviar. */
export function cepMismatch(cep: string, cmun: string): string | null {
  const uf = cepUf(cep);
  const city = MUNICIPIOS[cmun.replace(/\D/g, "")];
  const cityUf = city?.split("/").pop() ?? "";
  if (!uf || !cityUf || uf === cityUf) return null;
  const d = cep.replace(/\D/g, "");
  return `O CEP ${d.slice(0, 5)}-${d.slice(5)} é de ${uf}, mas o município do tomador é ${city}. A prefeitura recusa a nota assim: confira o endereço.`;
}

// ---------------------------------------------------------------------------
// A emissão (linha de nfse_emissions)
// ---------------------------------------------------------------------------

export type EmissionStatus = "queued" | "processing" | "issued" | "rejected" | "failed" | "canceled";

export interface EmissionError {
  codigo: string;
  mensagem: string;
}

export interface Emission {
  id: string;
  client_id: string;
  created_by: string | null;
  created_at: string;
  test_env: boolean;
  source: "ai" | "repeat" | "manual";
  request_text: string | null;
  toma_doc: string | null;
  toma_nome: string | null;
  c_trib_nac: string;
  c_trib_mun: string;
  servico_nome: string | null;
  description: string;
  amount: number | string;
  competence: string;
  status: EmissionStatus;
  job_id: string | null;
  n_dps: number | null;
  send_started_at: string | null;
  chave: string | null;
  numero: number | null;
  issued_at: string | null;
  errors: EmissionError[];
  last_message: string | null;
  steps: { started_at?: string; signed_at?: string; sent_at?: string; issued_at?: string };
  nfse_xml?: string | null;
  cancel_status: "requested" | "processing" | "rejected" | null;
  cancel_job_id: string | null;
  cancel_reason: string | null;
  cancel_errors: EmissionError[];
  canceled_at: string | null;
  custom_service?: boolean;
  c_nbs?: string | null;
  ibs_cst?: string | null;
  ibs_class_trib?: string | null;
  ibs_ind_op?: string | null;
}

export interface EmissionState {
  label: string;
  tone: Tone;
  /** a DPS saiu e o robô não conseguiu confirmar o resultado: é preciso conferir antes de emitir de novo */
  uncertain: boolean;
  /** ainda em andamento (a tela acompanha) */
  running: boolean;
}

export function emissionState(e: Pick<Emission, "status" | "cancel_status" | "send_started_at">): EmissionState {
  const base = { uncertain: false, running: false };
  if (e.status === "canceled") return { ...base, label: "Cancelada", tone: "gray" };
  if (e.status === "issued") {
    if (e.cancel_status === "requested" || e.cancel_status === "processing") return { ...base, label: "Cancelando", tone: "yellow", running: true };
    return { ...base, label: "Emitida", tone: "green" };
  }
  if (e.status === "rejected") return { ...base, label: "Recusada pela prefeitura", tone: "red" };
  if (e.status === "failed") {
    return e.send_started_at
      ? { ...base, label: "Confira na prefeitura", tone: "amber", uncertain: true }
      : { ...base, label: "Não emitida", tone: "red" };
  }
  return { ...base, label: e.status === "queued" ? "Na fila do robô" : "Emitindo", tone: "blue", running: true };
}

export interface EmissionStep {
  key: "queued" | "signed" | "sent" | "issued";
  label: string;
  hint: string;
  at: string | null;
  state: "done" | "now" | "todo";
}

/** Andamento em quatro passos, com o horário de cada um. */
export function emissionSteps(e: Pick<Emission, "status" | "created_at" | "steps" | "numero" | "issued_at">): EmissionStep[] {
  const s = e.steps ?? {};
  const done = e.status === "issued" || e.status === "canceled";
  const steps: Omit<EmissionStep, "state">[] = [
    { key: "queued", label: "Na fila do robô", hint: "computador do escritório", at: s.started_at ?? null },
    { key: "signed", label: "Assinada", hint: "com o certificado da empresa", at: s.signed_at ?? null },
    { key: "sent", label: "Enviada à prefeitura", hint: "aguardando a resposta", at: s.sent_at ?? null },
    { key: "issued", label: "Nota emitida", hint: e.numero ? `NFS-e nº ${e.numero}` : "número da nota", at: s.issued_at ?? e.issued_at ?? null },
  ];
  const stopped = e.status === "rejected" || e.status === "failed";
  let current = steps.findIndex((x) => !x.at);
  if (done) current = steps.length;
  if (current === -1) current = steps.length;
  return steps.map((x, i) => ({ ...x, state: i < current ? "done" : i === current && !stopped ? "now" : "todo" }));
}

const EXPLAIN_CODE: Record<string, string> = {
  L0005: "A empresa não está ativa no cadastro da prefeitura (ou não existe no ambiente de teste, que tem cadastro antigo).",
  L0001: "Este serviço não consta no cadastro da empresa na prefeitura. Escolha outro serviço.",
  L0017: "Faltou o código municipal do serviço.",
  L0022: "A série da nota está fora da faixa da API.",
};

const EXPLAIN_TEXT: [RegExp, string][] = [
  [/configura..o atividade/i, "A prefeitura não tem este serviço configurado para a empresa. Escolha outro serviço ou confira o cadastro dela na prefeitura."],
  [/tomador n.o identificado/i, "Este serviço não aceita nota sem tomador. Escolha ou cadastre o tomador."],
  [/estado deve ser informado/i, "Falta o endereço do tomador (município e CEP)."],
];

/** Explicação em português simples para uma recusa da prefeitura ("" quando não há). */
export function explainRejection(e: EmissionError): string {
  return EXPLAIN_CODE[e.codigo] ?? EXPLAIN_TEXT.find(([re]) => re.test(e.mensagem))?.[1] ?? "";
}

export const CANCEL_REASONS: { code: 1 | 2 | 9; label: string }[] = [
  { code: 1, label: "Erro na emissão" },
  { code: 2, label: "Serviço não prestado" },
  { code: 9, label: "Outro motivo" },
];

export const NFSE_PUBLIC_QUERY = "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=";

/** Mensagem pronta para colar no WhatsApp do cliente depois de emitir. */
export function clientNotice(e: Pick<Emission, "numero" | "amount" | "toma_nome" | "chave">): string {
  const para = e.toma_nome ? ` para ${e.toma_nome}` : "";
  const link = e.chave ? `\nPara conferir no portal nacional: ${NFSE_PUBLIC_QUERY}${e.chave}` : "";
  return `Olá! A nota fiscal de serviço nº ${e.numero ?? ""}${para}, no valor de ${formatBRL(e.amount)}, foi emitida. Segue o PDF em anexo.${link}`;
}

export function formatDoc(doc: string | null | undefined): string {
  const d = String(doc ?? "");
  if (/^\d{14}$/.test(d)) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (/^\d{11}$/.test(d)) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return d;
}

/** Resumo do mês para os números do topo da tela. */
export function monthSummary(list: Pick<Emission, "status" | "amount" | "created_at" | "test_env">[], month: string) {
  const mine = list.filter((e) => !e.test_env && e.created_at.slice(0, 7) === month);
  const sum = (rows: typeof mine) => rows.reduce((t, e) => t + Number(e.amount ?? 0), 0);
  const issued = mine.filter((e) => e.status === "issued");
  const canceled = mine.filter((e) => e.status === "canceled");
  return {
    issued: issued.length,
    issuedTotal: sum(issued),
    canceled: canceled.length,
    canceledTotal: sum(canceled),
    refused: mine.filter((e) => e.status === "rejected" || e.status === "failed").length,
  };
}
