import type { CertificateStatus, DocumentType, ExportTaskType, JobStatus, TaskStatus, TaskType } from "@/lib/types";

export type Tone = "gray" | "blue" | "yellow" | "green" | "red" | "orange";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Aguardando",
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

// Cinza = aguardando; Azul = processando; Amarelo = aguardando SEFAZ;
// Verde = concluído; Vermelho = erro; Laranja = intervenção manual.
export function jobTone(status: JobStatus): Tone {
  switch (status) {
    case "queued":
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
export const RETRYABLE_JOB_STATUSES: JobStatus[] = [
  "failed",
  "cancelled",
  "certificate_required",
  "manual_action_required",
];

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
  CHECK_PROCESSING: "Consulta de processamento",
  DOWNLOAD: "Download",
};

export const EXPORT_OPERATIONS: { value: ExportTaskType; label: string; flag: "uses_nfce" | "uses_nfe_issued" | "uses_nfe_received" }[] = [
  { value: "NFCE_EXPORT", label: "NFC-e", flag: "uses_nfce" },
  { value: "NFE_ISSUED_EXPORT", label: "NF-e emitidas", flag: "uses_nfe_issued" },
  { value: "NFE_RECEIVED_EXPORT", label: "NF-e recebidas", flag: "uses_nfe_received" },
];

export const DOCUMENT_LABEL: Record<DocumentType, string> = {
  NFCE: "NFC-e",
  NFE_EMITIDAS: "NF-e emitidas",
  NFE_RECEBIDAS: "NF-e recebidas",
};

export const CERTIFICATE_STATUS_LABEL: Record<CertificateStatus, string> = {
  valid: "Válido",
  expiring: "Vencendo",
  expired: "Vencido",
  error: "Erro",
};

export function certificateTone(status: CertificateStatus): Tone {
  return status === "valid" ? "green" : status === "expiring" ? "yellow" : "red";
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
  WORKER_LOST: "Worker interrompido",
  UNEXPECTED: "Erro inesperado",
};
