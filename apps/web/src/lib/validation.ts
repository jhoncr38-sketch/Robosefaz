import { z } from "zod";

import { normalizeCNPJ, validateCNPJ } from "@/lib/cnpj";
import { toCompetenceKey } from "@/lib/competence";

const optionalText = z
  .string()
  .trim()
  .max(255)
  .optional()
  .transform((v) => (v ? v : null));

export const clientSchema = z.object({
  legal_name: z.string().trim().min(2, "Informe a razão social").max(255),
  trade_name: optionalText,
  cnpj: z
    .string()
    .trim()
    .refine((v) => validateCNPJ(v), "CNPJ inválido")
    .transform((v) => normalizeCNPJ(v)),
  state_registration: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => (v ? v.replace(/\D/g, "") || null : null)),
  uf: z
    .string()
    .trim()
    .length(2, "UF com 2 letras")
    .transform((v) => v.toUpperCase()),
  email: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || z.email().safeParse(v).success, "E-mail inválido")
    .transform((v) => (v ? v : null)),
  phone: optionalText,
  active: z.boolean(),
  uses_nfce: z.boolean(),
  uses_nfe_issued: z.boolean(),
  uses_nfe_received: z.boolean(),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : null)),
});

export type ClientInput = z.input<typeof clientSchema>;
export type ClientOutput = z.output<typeof clientSchema>;

export const certificateSchema = z
  .object({
    client_id: z.uuid("Selecione o cliente"),
    type: z.enum(["A1", "A3"]),
    subject_name: z.string().trim().min(3, "Informe o titular (subject) do certificado").max(500),
    issuer: optionalText,
    serial_number: optionalText,
    thumbprint: optionalText,
    valid_from: z.string().optional().transform((v) => (v ? v : null)),
    valid_until: z.string().min(1, "Informe a validade"),
    requires_manual_selection: z.boolean(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => !v.valid_from || new Date(v.valid_from) < new Date(v.valid_until), {
    message: "Validade final deve ser posterior à inicial",
    path: ["valid_until"],
  });

export type CertificateInput = z.input<typeof certificateSchema>;

export const exportOperationSchema = z.enum(["NFCE_EXPORT", "NFE_ISSUED_EXPORT", "NFE_RECEIVED_EXPORT"]);

export const competenceSchema = z
  .string()
  .refine((v) => toCompetenceKey(v) !== null, "Competência inválida (use MM/AAAA)")
  .transform((v) => toCompetenceKey(v) as string);

export const automationRequestSchema = z.object({
  client_ids: z.array(z.uuid()).min(1, "Selecione ao menos um cliente").max(500),
  competence: competenceSchema,
  operations: z.array(exportOperationSchema).min(1, "Selecione ao menos uma operação"),
  force: z.boolean().default(false),
  respect_client_flags: z.boolean().default(true),
});

export const userCreateSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome").max(120),
  email: z.email("E-mail inválido"),
  role: z.enum(["admin", "operator", "viewer"]),
  password: z
    .string()
    .min(10, "Senha com no mínimo 10 caracteres")
    .max(72)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
