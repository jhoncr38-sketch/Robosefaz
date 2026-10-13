"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorize } from "@/lib/auth";
import { buildEmitProfile, EMISSION_COLUMNS, EMIT_NOTE_COLUMNS, NFSE_EMIT_RELEASED, type Emission, type EmitNote } from "@/lib/nfse-emit";
import type { Permission } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { validateCNPJ, validateCPF } from "@/lib/cnpj";
import { CNPJ_SOURCES, usableRecord } from "@/lib/cnpj-fontes";
import type { ActionResult } from "@/lib/types";

/** Autoriza uma ação da emissão. Enquanto a função não é lançada, só o dono da plataforma usa
 *  (para os demais, a aba aparece com cadeado). */
async function authorizeEmit(permission?: Permission): ReturnType<typeof authorize> {
  const auth = await authorize(permission);
  if ("error" in auth) return auth;
  if (!NFSE_EMIT_RELEASED && !auth.session.profile.is_platform_owner) return { error: "A emissão de NFS-e ainda não foi liberada." };
  return auth;
}

function rpcError(message: string): string {
  const m = /^(?:[A-Z_]+):\s*(.*)$/.exec(message);
  return m ? m[1] : message;
}

async function clientNotes(clientId: string): Promise<EmitNote[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notes")
    .select(EMIT_NOTE_COLUMNS)
    .eq("client_id", clientId)
    .eq("document_type", "NFSE_PRESTADAS")
    .order("emitida_em", { ascending: false })
    .limit(600);
  return (data ?? []) as EmitNote[];
}

/** As NFS-e prestadas mais recentes do cliente: delas saem os tomadores, os serviços e a nota-modelo. */
export async function loadEmitNotes(clientId: string): Promise<ActionResult<EmitNote[]>> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!z.uuid().safeParse(clientId).success) return { ok: false, error: "Cliente inválido" };
  return { ok: true, data: await clientNotes(clientId) };
}

// ---------------------------------------------------------------------------
// Pedido por mensagem: a IA só entende o texto. O serviço e a tributação nunca saem dela.
// ---------------------------------------------------------------------------

export interface ReadRequest {
  amount: number | null;
  takerDoc: string | null;
  takerQuoted: string;
  document: string;
  service: string | null;
  description: string;
  doubts: string[];
  /** CNPJ citado no pedido que não é tomador conhecido: nome e endereço já consultados */
  newTaker: TakerLookup | null;
}

const READ_SYSTEM =
  "Você extrai dados de um pedido de nota fiscal de serviço escrito por um cliente de um escritório de contabilidade. " +
  "Use a ferramenta para responder. Nunca invente: se o tomador não estiver claramente na lista, ou houver mais de um parecido, " +
  "deixe o índice vazio e explique em duvidas. Se o valor for ambíguo, deixe vazio e explique. " +
  "A descrição é um texto curto e limpo para o campo de descrição da nota, sem o valor e sem o nome do tomador.";

const READ_TOOL = {
  name: "nota",
  description: "Dados extraídos do pedido de nota fiscal de serviço.",
  input_schema: {
    type: "object",
    properties: {
      valor: { type: ["number", "null"], description: "Valor da nota em reais" },
      tomador: { type: ["integer", "null"], description: "Índice do tomador na lista de tomadores conhecidos" },
      tomador_citado: { type: "string", description: "O tomador como o cliente escreveu" },
      documento: { type: ["string", "null"], description: "CNPJ ou CPF citado no pedido, só dígitos" },
      servico: { type: ["integer", "null"], description: "Índice do serviço na lista de serviços da empresa" },
      descricao: { type: "string", description: "Descrição do serviço para a nota" },
      duvidas: { type: "array", items: { type: "string" }, description: "Pontos que a pessoa precisa conferir; vazio se não houver" },
    },
    required: ["valor", "tomador", "tomador_citado", "documento", "servico", "descricao", "duvidas"],
  },
} as const;

/** "Ler o pedido": extrai valor, tomador, serviço e descrição da mensagem do cliente. */
export async function readEmitRequest(input: { clientId: string; text: string }): Promise<ActionResult<ReadRequest>> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = z.object({ clientId: z.uuid(), text: z.string().trim().min(4, "Escreva o pedido do cliente").max(1500, "Pedido muito longo") }).safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "A leitura por IA não está configurada. Use “Repetir uma nota” ou “Preencher à mão”." };

  const profile = buildEmitProfile(await clientNotes(parsed.data.clientId));
  const takers = profile.takers.slice(0, 80);
  // só nomes vão para a IA: nunca CNPJ, certificado ou qualquer outro dado do cliente
  const prompt = [
    "Tomadores conhecidos:",
    ...takers.map((t, i) => `${i}: ${t.nome}`),
    "",
    "Serviços da empresa:",
    ...profile.services.map((s, i) => `${i}: ${s.nome}`),
    "",
    "Pedido do cliente:",
    parsed.data.text,
  ].join("\n");

  let answer: Record<string, unknown> | null = null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
        max_tokens: 600,
        system: READ_SYSTEM,
        tools: [READ_TOOL],
        tool_choice: { type: "tool", name: READ_TOOL.name },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
      answer = body.content?.find((c) => c.type === "tool_use")?.input ?? null;
    }
  } catch {
    answer = null;
  }
  if (!answer) return { ok: false, error: "A IA não respondeu agora. Tente de novo ou preencha à mão." };

  const index = <T,>(value: unknown, list: T[]): T | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < list.length ? list[value] : null);
  const taker = index(answer.tomador, takers);
  const suggested = index(answer.servico, profile.services);
  const doubts = (Array.isArray(answer.duvidas) ? answer.duvidas : []).filter((d): d is string => typeof d === "string" && d.trim() !== "").slice(0, 6);
  // o serviço vem da última nota para o tomador; a sugestão da IA só vale para tomador novo
  let service: string | null = taker ? taker.ultima.servico : (suggested?.id ?? null);
  if (taker && suggested && suggested.id !== taker.ultima.servico) {
    doubts.push(`O pedido parece ser de “${suggested.nome}”, mas a última nota para este tomador foi de “${taker.ultima.servicoNome}”. Confira o serviço.`);
  }
  if (!service) service = profile.services[0]?.id ?? null;
  const amount = typeof answer.valor === "number" && answer.valor > 0 ? Math.round(answer.valor * 100) / 100 : null;
  const document = String(answer.documento ?? "").replace(/\D/g, "").slice(0, 14);
  // CNPJ no pedido sem tomador conhecido: a consulta pública já traz nome e endereço
  const found = !taker && document.length === 14 ? await fetchTaker(document) : null;
  const newTaker = found?.ok ? (found.data ?? null) : null;
  if (newTaker) doubts.unshift("Tomador novo preenchido pela consulta pública do CNPJ: confira o nome e o endereço.");
  return {
    ok: true,
    data: {
      amount,
      takerDoc: taker?.doc ?? null,
      takerQuoted: String(answer.tomador_citado ?? "").slice(0, 120),
      document,
      service,
      description: String(answer.descricao ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      doubts,
      newTaker,
    },
  };
}

// ---------------------------------------------------------------------------
// Tomador novo: nome e endereço pela consulta pública do CNPJ
// ---------------------------------------------------------------------------

export interface TakerLookup {
  doc: string;
  nome: string;
  cmun: string;
  cidade: string;
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  situacao: string;
}

export async function lookupTaker(cnpj: string): Promise<ActionResult<TakerLookup>> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const doc = cnpj.replace(/\D/g, "");
  if (doc.length !== 14) return { ok: false, error: "Informe os 14 números do CNPJ (para CPF, digite os dados)." };
  return fetchTaker(doc);
}

/** Nome e endereço de um CNPJ nas fontes públicas (ver lib/cnpj-fontes). */
async function fetchTaker(doc: string): Promise<ActionResult<TakerLookup>> {
  // três fontes abertas, na ordem; uma fora do ar ou limitando pedidos não derruba a consulta
  let notFound = false;
  for (const source of CNPJ_SOURCES) {
    try {
      const res = await fetch(source.url(doc), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000), cache: "no-store" });
      if (res.status === 404) {
        notFound = true;
        continue;
      }
      if (!res.ok) {
        console.warn(`[cnpj] ${source.name} respondeu ${res.status}`);
        continue;
      }
      const record = source.parse((await res.json()) as Record<string, unknown>);
      if (!usableRecord(record)) continue;
      return { ok: true, data: { doc, ...record } };
    } catch (err) {
      console.warn(`[cnpj] ${source.name} não respondeu: ${String(err).slice(0, 80)}`);
    }
  }
  return {
    ok: false,
    error: notFound
      ? "CNPJ não encontrado na consulta pública. Digite os dados do tomador."
      : "A consulta pública do CNPJ não respondeu agora. Tente de novo ou digite os dados do tomador.",
  };
}

export interface CepLookup {
  cmun: string;
  cidade: string;
  logradouro: string;
  bairro: string;
}

/** Município (código IBGE), cidade, rua e bairro de um CEP, pela consulta pública (ViaCEP). */
export async function lookupCep(cep: string): Promise<ActionResult<CepLookup>> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const d = cep.replace(/\D/g, "");
  if (d.length !== 8) return { ok: false, error: "O CEP tem 8 números." };
  try {
    const res = await fetch(`https://viacep.com.br/ws/${d}/json/`, { signal: AbortSignal.timeout(6000), next: { revalidate: 86_400 } });
    if (!res.ok) return { ok: false, error: "CEP não encontrado." };
    const v = (await res.json()) as Record<string, string | boolean | undefined>;
    const text = (k: string) => String(v[k] ?? "").trim();
    if (v.erro || !/^\d{7}$/.test(text("ibge"))) return { ok: false, error: "CEP não encontrado." };
    return {
      ok: true,
      data: { cmun: text("ibge"), cidade: [text("localidade"), text("uf")].filter(Boolean).join("/"), logradouro: text("logradouro"), bairro: text("bairro") },
    };
  } catch {
    return { ok: false, error: "A consulta do CEP não respondeu." };
  }
}

// ---------------------------------------------------------------------------
// Emitir e cancelar
// ---------------------------------------------------------------------------

const key50 = z.string().regex(/^\d{50}$/, "Chave inválida");

const emissionSchema = z.object({
  client_id: z.uuid(),
  test_env: z.boolean().optional(),
  source: z.enum(["ai", "repeat", "manual"]),
  request_text: z.string().max(2000).optional(),
  model_chave: key50,
  toma_chave: key50.nullable().optional(),
  toma: z
    .object({
      doc: z
        .string()
        .min(11)
        .max(18)
        .refine((v) => {
          const d = v.replace(/\D/g, "");
          return d.length === 11 ? validateCPF(d) : d.length === 14 && validateCNPJ(d);
        }, "CNPJ ou CPF do tomador inválido"),
      nome: z.string().trim().min(2, "Informe o nome do tomador").max(150),
      cmun: z.string().regex(/^\d{7}$/, "Código do município inválido"),
      cep: z.string().regex(/^\d{5}-?\d{3}$/, "O CEP do tomador tem 8 números"),
      logradouro: z.string().trim().min(1, "Informe o logradouro").max(255),
      numero: z.string().trim().min(1, "Informe o número").max(60),
      complemento: z.string().trim().max(156).optional(),
      bairro: z.string().trim().min(1, "Informe o bairro").max(60),
    })
    .nullable()
    .optional(),
  description: z.string().trim().min(3, "Escreva a descrição do serviço").max(2000),
  amount: z.number().positive("Informe o valor").max(99_999_999),
  // atividade informada à mão (outra do cadastro da empresa), NBS e IBS/CBS como conferidos na tela
  custom_service: z.boolean().optional(),
  c_trib_nac: z.string().max(12).optional(),
  c_trib_mun: z.string().max(6).optional(),
  servico_nome: z.string().trim().max(300).optional(),
  c_nbs: z.string().max(14).optional(),
  ibs: z.object({ cst: z.string().max(4), class_trib: z.string().max(8), ind_op: z.string().max(8) }).optional(),
});

/** "Emitir nota": registra o pedido conferido; o robô do escritório assina e envia à prefeitura. */
export async function createEmission(input: z.input<typeof emissionSchema>): Promise<ActionResult<Emission>> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = emissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_nfse_emission", { p: parsed.data });
  if (error) return { ok: false, error: rpcError(error.message) };
  const id = (data as { emission_id: string }).emission_id;
  const { data: row } = await supabase.from("nfse_emissions").select(EMISSION_COLUMNS).eq("id", id).single();
  revalidatePath("/emissao");
  revalidatePath("/queue");
  return { ok: true, data: row as unknown as Emission };
}

const cancelSchema = z.object({
  id: z.uuid(),
  reasonCode: z.union([z.literal(1), z.literal(2), z.literal(9)]),
  reason: z.string().trim().min(15, "Explique o motivo em pelo menos 15 letras").max(255),
});

export async function cancelEmission(input: z.input<typeof cancelSchema>): Promise<ActionResult> {
  const auth = await authorizeEmit("automation:run");
  if ("error" in auth) return { ok: false, error: auth.error };
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_nfse_cancel", {
    p_emission_id: parsed.data.id,
    p_reason_code: parsed.data.reasonCode,
    p_reason: parsed.data.reason,
  });
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidatePath("/emissao");
  revalidatePath("/queue");
  return { ok: true, message: "Cancelamento enviado ao robô." };
}

/** A linha atual de uma emissão (reserva para quando o tempo real não chega). */
export async function loadEmission(id: string): Promise<ActionResult<Emission>> {
  const auth = await authorizeEmit();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Nota inválida" };
  const supabase = await createClient();
  const { data } = await supabase.from("nfse_emissions").select(EMISSION_COLUMNS).eq("id", id).maybeSingle();
  if (!data) return { ok: false, error: "Nota não encontrada" };
  return { ok: true, data: data as unknown as Emission };
}

/** XML da nota emitida, para montar o DANFSe. */
export async function loadEmissionXml(id: string): Promise<ActionResult<{ xml: string; canceled: boolean }>> {
  const auth = await authorizeEmit();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Nota inválida" };
  const supabase = await createClient();
  const { data } = await supabase.from("nfse_emissions").select("nfse_xml, status").eq("id", id).maybeSingle();
  if (!data?.nfse_xml) return { ok: false, error: "O XML desta nota ainda não está disponível." };
  return { ok: true, data: { xml: data.nfse_xml as string, canceled: data.status === "canceled" } };
}

/** Dono da plataforma: liga ou desliga a emissão de NFS-e de um escritório. */
export async function setOrgNfseEmit(orgId: string, enabled: boolean): Promise<ActionResult> {
  const auth = await authorize();
  if ("error" in auth) return { ok: false, error: auth.error };
  if (!auth.session.profile.is_platform_owner) return { ok: false, error: "Só o dono da plataforma liga a emissão de NFS-e." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_org_nfse_emit", { p_org_id: orgId, p_enabled: enabled });
  if (error) return { ok: false, error: rpcError(error.message) };
  revalidatePath("/emissao");
  revalidatePath("/organizations");
  return { ok: true, message: enabled ? "Emissão de NFS-e ligada para este escritório." : "Emissão de NFS-e desligada para este escritório." };
}
