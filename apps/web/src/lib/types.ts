export type UserRole = "admin" | "operator" | "viewer";

export type JobStatus =
  | "queued"
  | "starting"
  | "opening_browser"
  | "opening_siat"
  | "waiting_certificate"
  | "authenticating"
  | "selecting_taxpayer"
  | "opening_siat_module"
  | "navigating_export"
  | "scheduling_nfce"
  | "scheduling_nfe_issued"
  | "scheduling_nfe_received"
  | "waiting_sefaz"
  | "checking_processing"
  | "download_available"
  | "downloading"
  | "organizing_files"
  | "completed"
  | "failed"
  | "cancelled"
  | "manual_action_required"
  | "certificate_required";

export type TaskType =
  | "NFCE_EXPORT"
  | "NFE_ISSUED_EXPORT"
  | "NFE_RECEIVED_EXPORT"
  | "NFCE_CANCELED_EXPORT"
  | "NFE_ISSUED_CANCELED_EXPORT"
  | "NFE_RECEIVED_CANCELED_EXPORT"
  | "NFE_KEY_EXPORT"
  | "CHECK_PROCESSING"
  | "DOWNLOAD"
  | "EFD_CHECK"
  | "MALHA_CHECK"
  | "NFSE_FETCH";

/** pedidos normais (só as notas ativas) */
export type RegularExportTaskType = Extract<TaskType, "NFCE_EXPORT" | "NFE_ISSUED_EXPORT" | "NFE_RECEIVED_EXPORT">;
/** notas canceladas: pedido separado, com Status "Canceladas" (botão "Canceladas" do agendamento) */
export type CanceledExportTaskType = Extract<
  TaskType,
  "NFCE_CANCELED_EXPORT" | "NFE_ISSUED_CANCELED_EXPORT" | "NFE_RECEIVED_CANCELED_EXPORT"
>;
export type ExportTaskType = RegularExportTaskType | CanceledExportTaskType;
/** o que um trabalho do robô pode conter: exportações do mês, uma nota pela chave, EFD, malhas ou NFS-e */
export type JobOperation = ExportTaskType | "NFE_KEY_EXPORT" | "EFD_CHECK" | "MALHA_CHECK" | "NFSE_FETCH";

export type TaskStatus =
  | "pending"
  | "running"
  | "scheduled"
  | "processed"
  | "downloaded"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "dry_run";

export type DocumentType =
  | "NFCE"
  | "NFE_EMITIDAS"
  | "NFE_RECEBIDAS"
  | "NFCE_CANCELADAS"
  | "NFE_EMITIDAS_CANCELADAS"
  | "NFE_RECEBIDAS_CANCELADAS"
  /** NFS-e Nacional (notas de serviço, lidas da API do ADN) */
  | "NFSE_PRESTADAS"
  | "NFSE_TOMADAS";

export type CertificateStatus = "valid" | "expiring" | "expired" | "error";

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  org_id: string | null;
  is_platform_owner: boolean;
  organizations?: { name: string; status: OrganizationStatus } | null;
  created_at: string;
  updated_at: string;
}

export type OrganizationStatus = "active" | "suspended";

/** Computador com o robô, ativado por código e vinculado a um escritório. */
export interface Device {
  id: string;
  org_id: string;
  name: string;
  status: "active" | "revoked";
  robot_version: string | null;
  activated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** Escritório com os números exibidos ao dono da plataforma (RPC platform_organizations). */
export interface PlatformOrganization {
  id: string;
  name: string;
  status: OrganizationStatus;
  max_clients: number | null;
  notes: string | null;
  created_at: string;
  users: number;
  clients: number;
  devices: number;
  jobs_30d: number;
  last_activity: string | null;
}

export interface Client {
  id: string;
  client_code: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
  state_registration: string | null;
  uf: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  /** tem inscrição estadual e é atendida pelo SIAT; false = só serviço (NFS-e Nacional) */
  uses_siat: boolean;
  uses_nfce: boolean;
  uses_nfe_issued: boolean;
  uses_nfe_received: boolean;
  provider: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Certificate {
  id: string;
  client_id: string;
  type: "A1" | "A3";
  subject_name: string;
  issuer: string | null;
  serial_number: string | null;
  thumbprint: string | null;
  valid_from: string | null;
  valid_until: string;
  browser_profile: string | null;
  status: CertificateStatus;
  active: boolean;
  requires_manual_selection: boolean;
  has_secret: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientRef {
  client_code: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string;
}

export interface AutomationJob {
  id: string;
  client_id: string;
  created_by: string | null;
  provider: string;
  competence: string;
  start_date: string;
  end_date: string;
  /** exportações de notas, ["NFE_KEY_EXPORT"] (uma nota pela chave), ["EFD_CHECK"] ou ["MALHA_CHECK"] */
  operations: JobOperation[];
  force_reschedule: boolean;
  /** nota pela chave: a chave de acesso pedida na tela Notas */
  note_key?: string | null;
  status: JobStatus;
  current_step: string | null;
  progress: number;
  last_message: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  next_check_at: string | null;
  check_count: number;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  error_screenshot_path: string | null;
  manual_action_message: string | null;
  manual_action_requested_at: string | null;
  manual_action_confirmed_at: string | null;
  cancel_requested: boolean;
  locked_at: string | null;
  locked_by: string | null;
  /** computadores sem o certificado do cliente, que repassaram o trabalho */
  skip_hosts?: string[] | null;
  created_at: string;
  updated_at: string;
  clients?: ClientRef | null;
}

export interface AutomationTask {
  id: string;
  job_id: string;
  client_id: string;
  task_type: TaskType;
  status: TaskStatus;
  competence: string;
  document_type: DocumentType | null;
  operation_type: string | null;
  dedup_key: string | null;
  superseded: boolean;
  external_request_id: string | null;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  retry_count: number;
  error_message: string | null;
  result: Record<string, unknown>;
  created_at: string;
}

export interface AutomationLog {
  id: number;
  job_id: string | null;
  task_id: string | null;
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  step: string | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DownloadRow {
  id: string;
  client_id: string;
  job_id: string | null;
  automation_task_id: string | null;
  document_type: DocumentType;
  competence: string;
  filename: string;
  filepath: string;
  size: number;
  checksum: string;
  downloaded_at: string;
  /** código do arquivo no Google Drive (gravado pelo robô quando a nota sobe) */
  drive_file_id?: string | null;
  /** pastas no Drive: ano/mês/cliente e ano/mês ("Baixar todas") */
  drive_client_folder_id?: string | null;
  drive_month_folder_id?: string | null;
  /** notas (XMLs) dentro do ZIP; contadas pelo robô na manutenção, null até lá */
  note_count?: number | null;
  clients?: ClientRef | null;
}

/** Uma nota (XML) dentro de um ZIP baixado, lida pelo robô (tela Notas). */
export interface NoteRow {
  id: string;
  org_id: string;
  client_id: string;
  /** null depois que a limpeza automática apaga o registro do download (o ZIP fica) */
  download_id: string | null;
  document_type: DocumentType;
  competence: string;
  chave: string;
  modelo: number | null;
  serie: number | null;
  numero: number | null;
  emitida_em: string | null;
  valor: string | number | null;
  emit_doc: string | null;
  emit_nome: string | null;
  emit_uf: string | null;
  dest_doc: string | null;
  dest_nome: string | null;
  dest_uf: string | null;
  cstat: string | null;
  /** veio do ZIP de canceladas (o XML é o da nota autorizada); NFS-e: cancelada por evento */
  canceled: boolean;
  /** só NFS-e: ISS retido, valor do ISS, município de incidência e descrição do serviço */
  iss_retido?: boolean | null;
  iss_valor?: string | number | null;
  municipio?: string | null;
  servico?: string | null;
  zip_path: string;
  xml_name: string;
  /** XML da nota, só depois que alguém pediu para ver */
  xml?: string | null;
  xml_requested_at: string | null;
  xml_at: string | null;
  xml_error: string | null;
  created_at: string;
  clients?: { client_code: string; legal_name: string; trade_name: string | null; cnpj: string } | null;
  downloads?: { filename: string; drive_file_id: string | null } | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  level: "info" | "success" | "warning" | "error";
  title: string;
  message: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  client_id: string | null;
  ip: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface WorkerHeartbeat {
  worker_id: string;
  kind: string;
  hostname: string | null;
  status: string;
  current_job_id: string | null;
  meta: Record<string, unknown>;
  started_at: string;
  last_seen_at: string;
}

/** Situação da EFD lida no DT-e (mensagem "EPE - EFD" do SIAT). */
export type EfdSituation = "processed" | "alert" | "pending" | "not_processed";

export interface EfdInconsistency {
  type: number;
  type_label: string;
  rule: string;
  description: string;
}

export interface EfdDeclaration {
  id: string;
  client_id: string;
  job_id: string | null;
  competence: string;
  epe_number: string;
  finalidade: string | null;
  processed: boolean | null;
  situation: EfdSituation;
  processed_at: string | null;
  received_at: string | null;
  message_sent_at: string | null;
  subject: string | null;
  inconsistencies: EfdInconsistency[];
  raw_text: string | null;
  checked_at: string;
}

/** Consulta de Malhas Fiscais (SIAT web): uma foto por cliente, lida pelo robô. */
export type MalhaSource = "DIEF_PGDAS" | "EFD_OIE";

export interface MalhaFinding {
  source: MalhaSource;
  identification: string;
  periods: number | null;
  icms: number | null;
  nfe_count: number | null;
  raw: string;
}

export interface MalhaCheck {
  id: string;
  client_id: string;
  job_id: string | null;
  state_registration: string | null;
  legal_name: string | null;
  findings: MalhaFinding[];
  total: number;
  icms_total: number | string | null;
  nfe_total: number | null;
  raw_text: string | null;
  checked_at: string;
}

export interface AppSetting {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
}

export interface DashboardStats {
  clients_active: number;
  certificates_valid: number;
  certificates_expiring: number;
  certificates_expired: number;
  jobs_today: number;
  jobs_processing: number;
  jobs_waiting_sefaz: number;
  downloads_available: number;
  jobs_completed: number;
  jobs_failed: number;
  jobs_queued: number;
  jobs_manual: number;
}

export interface CreateJobResult {
  job_id: string | null;
  client_id: string;
  duplicate?: boolean;
  operations?: ExportTaskType[];
  skipped?: { operation: ExportTaskType; reason: string; message: string }[];
  message?: string;
  error?: string;
}

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };
