import type {
  CanceledExportTaskType,
  CertificateStatus,
  DocumentType,
  ExportTaskType,
  JobStatus,
  RegularExportTaskType,
  TaskStatus,
  TaskType,
} from "@/lib/types";

// slate = na fila; amber = certificado vencendo (não confundir com "Aguardando SEFAZ")
export type Tone = "gray" | "blue" | "yellow" | "green" | "red" | "orange" | "purple" | "slate" | "amber";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Na fila",
  starting: "Iniciando",
  opening_browser: "Abrindo navegador",
  opening_siat: "Abrindo SIAT",
  waiting_certificate: "Aguardando certificado",
  authenticating: "Autenticando",
  selecting_taxpayer: "Selecionando contribuinte",
  opening_siat_module: "Abrindo módulo",
  navigating_export: "Navegando até exportação",
  scheduling_nfce: "Agendando NFC-e",
  scheduling_nfe_issued: "Agendando NF-e emitidas",
  scheduling_nfe_received: "Agendando NF-e recebidas",
  waiting_sefaz: "Aguardando SEFAZ",
  checking_processing: "Consultando processamento",
  download_available: "Download disponível",
  downloading: "Baixando arquivos",
  organizing_files: "Organizando arquivos",
  completed: "Concluído",
  failed: "Erro",
  cancelled: "Cancelado",
  manual_action_required: "Intervenção manual",
  certificate_required: "Certificado necessário",
};

// Ardósia = na fila; Cinza = cancelado; Azul = processando; Amarelo = aguardando SEFAZ;
// Verde = concluído; Vermelho = erro; Laranja = intervenção manual.
export function jobTone(status: JobStatus): Tone {
  switch (status) {
    case "queued":
      return "slate";
    case "cancelled":
      return "gray";
    case "waiting_sefaz":
      return "yellow";
    case "completed":
      return "green";
    case "failed":
    case "certificate_required":
      return "red";
    case "manual_action_required":
    case "waiting_certificate":
      return "orange";
    default:
      return "blue";
  }
}

export const FINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];
export const MANUAL_JOB_STATUSES: JobStatus[] = ["manual_action_required", "waiting_certificate"];
export const RETRYABLE_JOB_STATUSES: JobStatus[] = ["failed", "cancelled", "certificate_required", "manual_action_required"];

export function isJobRunning(status: JobStatus): boolean {
  return !["queued", "waiting_sefaz", "completed", "failed", "cancelled", "certificate_required"].includes(status);
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pendente",
  running: "Executando",
  scheduled: "Agendado",
  processed: "Processado",
  downloaded: "Baixado",
  completed: "Concluído",
  failed: "Erro",
  skipped: "Ignorado",
  cancelled: "Cancelado",
  dry_run: "Simulado",
};

export function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case "pending":
    case "skipped":
    case "cancelled":
      return "gray";
    case "scheduled":
      return "yellow";
    case "completed":
    case "downloaded":
    case "processed":
      return "green";
    case "failed":
      return "red";
    case "dry_run":
      return "orange";
    default:
      return "blue";
  }
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  NFCE_EXPORT: "NFC-e",
  NFE_ISSUED_EXPORT: "NF-e emitidas",
  NFE_RECEIVED_EXPORT: "NF-e recebidas",
  NFCE_CANCELED_EXPORT: "NFC-e canceladas",
  NFE_ISSUED_CANCELED_EXPORT: "NF-e emitidas canceladas",
  NFE_RECEIVED_CANCELED_EXPORT: "NF-e recebidas canceladas",
  NFE_KEY_EXPORT: "Nota pela chave",
  CHECK_PROCESSING: "Consulta de processamento",
  DOWNLOAD: "Download",
  EFD_CHECK: "Consulta EFD",
  MALHA_CHECK: "Consulta de malhas",
  NFSE_FETCH: "NFS-e Nacional",
  NFSE_EMIT: "Emissão de NFS-e",
  NFSE_CANCEL: "Cancelamento de NFS-e",
};

export const EXPORT_OPERATIONS: {
  value: RegularExportTaskType;
  label: string;
  flag: "uses_nfce" | "uses_nfe_issued" | "uses_nfe_received";
}[] = [
  { value: "NFCE_EXPORT", label: "NFC-e", flag: "uses_nfce" },
  { value: "NFE_ISSUED_EXPORT", label: "NF-e emitidas", flag: "uses_nfe_issued" },
  { value: "NFE_RECEIVED_EXPORT", label: "NF-e recebidas", flag: "uses_nfe_received" },
];

/** pedido de canceladas de cada tipo (botão "Canceladas" do agendamento) */
export const CANCELED_OPERATION: Record<RegularExportTaskType, CanceledExportTaskType> = {
  NFCE_EXPORT: "NFCE_CANCELED_EXPORT",
  NFE_ISSUED_EXPORT: "NFE_ISSUED_CANCELED_EXPORT",
  NFE_RECEIVED_EXPORT: "NFE_RECEIVED_CANCELED_EXPORT",
};

/** Operações enviadas ao agendar: cada tipo marcado e, com "Canceladas", as canceladas dele. */
export function withCanceled(ops: RegularExportTaskType[], canceled: boolean): ExportTaskType[] {
  return canceled ? ops.flatMap((o) => [o, CANCELED_OPERATION[o]]) : ops;
}

export const DOCUMENT_LABEL: Record<DocumentType, string> = {
  NFCE: "NFC-e",
  NFE_EMITIDAS: "NF-e emitidas",
  NFE_RECEBIDAS: "NF-e recebidas",
  NFCE_CANCELADAS: "NFC-e canceladas",
  NFE_EMITIDAS_CANCELADAS: "NF-e emitidas canceladas",
  NFE_RECEBIDAS_CANCELADAS: "NF-e recebidas canceladas",
  NFSE_PRESTADAS: "NFS-e prestadas",
  NFSE_TOMADAS: "NFS-e tomadas",
  NFSE_PRESTADAS_CANCELADAS: "NFS-e prestadas canceladas",
  NFSE_TOMADAS_CANCELADAS: "NFS-e tomadas canceladas",
};

/** Notas de serviço (NFS-e Nacional). */
export function isNfseDocument(doc: DocumentType): boolean {
  return doc.startsWith("NFSE_");
}

const CANCELED_BASE: Partial<Record<DocumentType, DocumentType>> = {
  NFCE_CANCELADAS: "NFCE",
  NFE_EMITIDAS_CANCELADAS: "NFE_EMITIDAS",
  NFE_RECEBIDAS_CANCELADAS: "NFE_RECEBIDAS",
  NFSE_PRESTADAS_CANCELADAS: "NFSE_PRESTADAS",
  NFSE_TOMADAS_CANCELADAS: "NFSE_TOMADAS",
};

export function isCanceledDocument(doc: DocumentType): boolean {
  return doc in CANCELED_BASE;
}

/** NF-e emitidas canceladas -> NF-e emitidas (a etiqueta "canceladas" fica à parte). */
export function baseDocument(doc: DocumentType): DocumentType {
  return CANCELED_BASE[doc] ?? doc;
}

export const CERTIFICATE_STATUS_LABEL: Record<CertificateStatus, string> = {
  valid: "Válido",
  expiring: "Vencendo",
  expired: "Vencido",
  error: "Erro",
};

export function certificateTone(status: CertificateStatus): Tone {
  return status === "valid" ? "green" : status === "expiring" ? "amber" : "red";
}

/** Status calculado no cliente (independe do job de atualização do banco). */
export function certificateStatusFromDate(validUntil: string | null | undefined, now = new Date()): CertificateStatus {
  if (!validUntil) return "error";
  const diff = new Date(validUntil).getTime() - now.getTime();
  if (diff <= 0) return "expired";
  if (diff <= 30 * 24 * 60 * 60 * 1000) return "expiring";
  return "valid";
}

export const ERROR_CODE_LABEL: Record<string, string> = {
  TAXPAYER_MISMATCH: "Contribuinte divergente",
  SECURITY_CLIENT_MISMATCH: "Bloqueio de segurança: cliente divergente",
  CERTIFICATE_EXPIRED: "Certificado vencido",
  CERTIFICATE_REQUIRED: "Certificado necessário",
  INVALID_CONFIGURATION: "Configuração inválida",
  MANUAL_ACTION_REQUIRED: "Intervenção manual não concluída",
  SIAT_UNAVAILABLE: "SIAT indisponível",
  LOGIN_FAILED: "Falha no login",
  SELECTOR_NOT_FOUND: "Elemento do portal não encontrado",
  TIMEOUT: "Tempo esgotado",
  SCHEDULE_FAILED: "Falha no agendamento",
  EXPORT_FAILED: "Exportação com erro na SEFAZ",
  DOWNLOAD_FAILED: "Falha no download",
  PROFILE_IN_USE: "Perfil do navegador em uso",
  BROWSER_ERROR: "Erro no navegador",
  COLLECTOR_EXHAUSTED: "Arquivo não disponibilizado a tempo",
  NFSE_UNAVAILABLE: "NFS-e Nacional indisponível",
  WORKER_LOST: "Worker interrompido",
  LOCK_LOST: "Trabalho passou para outro computador",
  UNEXPECTED: "Erro inesperado",
};

/** O que fazer em cada erro, em linguagem simples: é o que o usuário vê no Histórico. O código técnico fica no detalhe. */
export const ERROR_ADVICE: Record<string, string> = {
  TAXPAYER_MISMATCH: "O certificado abriu outro contribuinte no SIAT. Confira o CNPJ e a inscrição estadual no cadastro da empresa.",
  SECURITY_CLIENT_MISMATCH: "O SIAT abriu outra inscrição estadual com esse certificado. Confira a inscrição no cadastro antes de reprocessar.",
  CERTIFICATE_EXPIRED: "O certificado venceu. Instale o novo no computador do robô e cadastre em Certificados.",
  CERTIFICATE_REQUIRED: "O certificado não está instalado em nenhum computador ligado. Instale o A1 e clique em Reprocessar.",
  INVALID_CONFIGURATION: "Falta algo no cadastro (empresa inativa, sem certificado ou dado incompleto). Corrija e reprocesse.",
  MANUAL_ACTION_REQUIRED: "O robô esperou uma ação sua no SIAT e o tempo acabou. Reprocesse e acompanhe pela Fila.",
  SIAT_UNAVAILABLE: "O SIAT estava fora do ar. Reprocesse mais tarde.",
  LOGIN_FAILED: "O SIAT não aceitou o login. Confira se o certificado é da empresa certa e se está válido.",
  SELECTOR_NOT_FOUND: "O SIAT mudou uma tela ou não carregou. Reprocesse; se repetir, avise o suporte.",
  TIMEOUT: "O SIAT ou o computador demorou demais. Reprocesse; se repetir no mesmo computador, ele pode estar lento.",
  SCHEDULE_FAILED: "O SIAT recusou o pedido das notas. Veja a mensagem no detalhe e reprocesse.",
  EXPORT_FAILED: "A SEFAZ devolveu o pedido com erro. Veja a mensagem no detalhe; pode ser preciso pedir de novo.",
  EXPORT_NOT_FOUND: "O pedido sumiu da lista do SIAT. Reprocesse para pedir de novo.",
  EXPORT_ALREADY_SCHEDULED: "Já havia um pedido igual no SIAT. Aguarde a SEFAZ processar; o robô baixa quando ficar pronto.",
  DOWNLOAD_FAILED: "O arquivo não baixou. Confira a pasta das notas e o espaço em disco, e reprocesse.",
  PROFILE_IN_USE: "O navegador do robô já estava aberto para essa empresa. Reprocesse; se repetir, reinicie o robô.",
  BROWSER_ERROR: "O navegador do robô não abriu ou travou. Reprocesse; se repetir, o computador pode estar lento.",
  COLLECTOR_EXHAUSTED: "A SEFAZ não disponibilizou o arquivo no prazo. Reprocesse para pedir de novo.",
  NFSE_UNAVAILABLE: "A NFS-e Nacional ou a prefeitura não respondeu. Reprocesse mais tarde.",
  NFSE_REJECTED: "A prefeitura recusou a nota. Veja o motivo na aba Emitir NFS-e e corrija antes de emitir de novo.",
  WORKER_LOST: "O computador do robô desligou no meio. Reprocesse quando um robô estiver ligado.",
  LOCK_LOST: "Outro computador assumiu este trabalho; o resultado que vale é o dele.",
  CANCELLED: "Cancelado por um usuário.",
  UNEXPECTED: "Erro inesperado. Reprocesse; se repetir, abra o detalhe e avise o suporte.",
};

export function errorAdvice(code: string | null | undefined): string | null {
  return code ? (ERROR_ADVICE[code] ?? null) : null;
}
