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

export type TaskType = "NFCE_EXPORT" | "NFE_ISSUED_EXPORT" | "NFE_RECEIVED_EXPORT" | "CHECK_PROCESSING" | "DOWNLOAD";

export type ExportTaskType = Extract<TaskType, "NFCE_EXPORT" | "NFE_ISSUED_EXPORT" | "NFE_RECEIVED_EXPORT">;

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

export type DocumentType = "NFCE" | "NFE_EMITIDAS" | "NFE_RECEBIDAS";

export type CertificateStatus = "valid" | "expiring" | "expired" | "error";

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  created_at: string;
  updated_at: string;
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
  operations: ExportTaskType[];
  force_reschedule: boolean;
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
  clients?: ClientRef | null;
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
