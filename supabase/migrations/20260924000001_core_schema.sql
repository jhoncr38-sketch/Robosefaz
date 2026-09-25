-- =====================================================================
-- SIAT Automation - Core schema
-- Tabelas: profiles, clients, certificates, automation_jobs,
--          automation_tasks, automation_logs, downloads, audit_logs,
--          notifications, worker_heartbeats, app_settings
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.user_role as enum ('admin', 'operator', 'viewer');

create type public.certificate_type as enum ('A1', 'A3');

create type public.certificate_status as enum ('valid', 'expiring', 'expired', 'error');

create type public.job_status as enum (
  'queued',
  'starting',
  'opening_browser',
  'opening_siat',
  'waiting_certificate',
  'authenticating',
  'selecting_taxpayer',
  'opening_siat_module',
  'navigating_export',
  'scheduling_nfce',
  'scheduling_nfe_issued',
  'scheduling_nfe_received',
  'waiting_sefaz',
  'checking_processing',
  'download_available',
  'downloading',
  'organizing_files',
  'completed',
  'failed',
  'cancelled',
  'manual_action_required',
  'certificate_required'
);

create type public.task_type as enum (
  'NFCE_EXPORT',
  'NFE_ISSUED_EXPORT',
  'NFE_RECEIVED_EXPORT',
  'CHECK_PROCESSING',
  'DOWNLOAD'
);

create type public.task_status as enum (
  'pending',
  'running',
  'scheduled',
  'processed',
  'downloaded',
  'completed',
  'failed',
  'skipped',
  'cancelled',
  'dry_run'
);

create type public.log_level as enum ('DEBUG', 'INFO', 'WARNING', 'ERROR');

create type public.document_type as enum ('NFCE', 'NFE_EMITIDAS', 'NFE_RECEBIDAS');

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Validação de CNPJ numérico e alfanumérico (IN RFB 2.229/2024).
-- Cada caractere vale (ascii - 48); dígitos verificadores são sempre numéricos.
create or replace function public.is_valid_cnpj(p_cnpj text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := upper(regexp_replace(coalesce(p_cnpj, ''), '[^0-9A-Za-z]', '', 'g'));
  w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
  w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  s int;
  d1 int;
  d2 int;
  i int;
begin
  if length(v) <> 14 then
    return false;
  end if;
  if v !~ '^[0-9A-Z]{12}[0-9]{2}$' then
    return false;
  end if;
  if v ~ '^(.)\1{13}$' then
    return false;
  end if;

  s := 0;
  for i in 1..12 loop
    s := s + (ascii(substr(v, i, 1)) - 48) * w1[i];
  end loop;
  d1 := case when s % 11 < 2 then 0 else 11 - (s % 11) end;

  s := 0;
  for i in 1..13 loop
    s := s + (ascii(substr(v, i, 1)) - 48) * w2[i];
  end loop;
  d2 := case when s % 11 < 2 then 0 else 11 - (s % 11) end;

  return substr(v, 13, 1)::int = d1 and substr(v, 14, 1)::int = d2;
end;
$$;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null default '',
  email text not null,
  role public.user_role not null default 'viewer',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Cria o profile automaticamente. O primeiro usuário do sistema vira admin;
-- os demais entram como viewer, salvo papel definido pelo admin (app_metadata).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
begin
  if not exists (select 1 from public.profiles) then
    v_role := 'admin';
  else
    -- papel vem de raw_app_meta_data (só a service role altera); nunca de
    -- raw_user_meta_data, que o próprio usuário controla no signup.
    v_role := coalesce(
      nullif(new.raw_app_meta_data ->> 'role', '')::public.user_role,
      'viewer'
    );
  end if;

  insert into public.profiles (user_id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    v_role
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------
create sequence public.client_code_seq start 1;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  client_code text not null unique
    default ('CLI' || lpad(nextval('public.client_code_seq')::text, 6, '0')),
  legal_name text not null,
  trade_name text,
  cnpj varchar(14) not null unique,
  state_registration text,
  uf char(2) not null default 'PI',
  email text,
  phone text,
  active boolean not null default true,
  uses_nfce boolean not null default true,
  uses_nfe_issued boolean not null default true,
  uses_nfe_received boolean not null default true,
  provider text not null default 'SIAT',
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_cnpj_format check (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  constraint clients_cnpj_valid check (public.is_valid_cnpj(cnpj)),
  constraint clients_uf_format check (uf ~ '^[A-Z]{2}$'),
  constraint clients_legal_name_not_blank check (length(trim(legal_name)) > 0)
);

create index clients_cnpj_idx on public.clients (cnpj);
create index clients_active_idx on public.clients (active);

create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- certificates
-- Nunca guardar senha aqui. A senha (se necessária) fica no cofre do worker
-- (Windows Credential Manager / arquivo cifrado), chave derivada do id.
-- ---------------------------------------------------------------------
create table public.certificates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  type public.certificate_type not null default 'A1',
  subject_name text not null,
  issuer text,
  serial_number text,
  thumbprint text,
  valid_from timestamptz,
  valid_until timestamptz not null,
  browser_profile text,
  status public.certificate_status not null default 'valid',
  active boolean not null default true,
  requires_manual_selection boolean not null default false,
  has_secret boolean not null default false,
  notes text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint certificates_validity_range check (valid_from is null or valid_from < valid_until)
);

create index certificates_client_id_idx on public.certificates (client_id);
create index certificates_valid_until_idx on public.certificates (valid_until);
create unique index certificates_one_active_per_client
  on public.certificates (client_id) where active;

create or replace function public.compute_certificate_status(p_valid_until timestamptz)
returns public.certificate_status
language sql
stable
as $$
  select case
    when p_valid_until is null then 'error'::public.certificate_status
    when p_valid_until <= now() then 'expired'::public.certificate_status
    when p_valid_until <= now() + interval '30 days' then 'expiring'::public.certificate_status
    else 'valid'::public.certificate_status
  end;
$$;

create or replace function public.certificates_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.status := public.compute_certificate_status(new.valid_until);
  elsif new.valid_until is distinct from old.valid_until or new.status <> 'error' then
    new.status := public.compute_certificate_status(new.valid_until);
  end if;
  if new.browser_profile is null or new.browser_profile = '' then
    new.browser_profile := new.client_id::text;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger certificates_before_write
before insert or update on public.certificates
for each row execute function public.certificates_before_write();

-- Atualiza status de todos os certificados (chamado periodicamente pelo worker).
create or replace function public.refresh_certificate_statuses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.certificates
     set status = public.compute_certificate_status(valid_until),
         last_checked_at = now()
   where status <> 'error'
     and status is distinct from public.compute_certificate_status(valid_until);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- automation_jobs
-- ---------------------------------------------------------------------
create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  provider text not null default 'SIAT',
  competence char(7) not null,
  start_date date not null,
  end_date date not null,
  operations public.task_type[] not null,
  force_reschedule boolean not null default false,
  status public.job_status not null default 'queued',
  current_step text,
  progress smallint not null default 0,
  last_message text,
  attempts smallint not null default 0,
  max_attempts smallint not null default 3, -- retentativas automáticas (além da 1ª execução)
  next_attempt_at timestamptz not null default now(),
  next_check_at timestamptz,
  check_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  error_screenshot_path text,
  manual_action_message text,
  manual_action_requested_at timestamptz,
  manual_action_confirmed_at timestamptz,
  manual_action_confirmed_by uuid references auth.users (id) on delete set null,
  cancel_requested boolean not null default false,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_jobs_competence_format check (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint automation_jobs_dates check (start_date <= end_date),
  constraint automation_jobs_progress check (progress between 0 and 100),
  constraint automation_jobs_operations_not_empty check (cardinality(operations) > 0)
);

create index automation_jobs_client_id_idx on public.automation_jobs (client_id);
create index automation_jobs_status_idx on public.automation_jobs (status);
create index automation_jobs_competence_idx on public.automation_jobs (competence);
create index automation_jobs_created_at_idx on public.automation_jobs (created_at desc);
create index automation_jobs_queue_idx on public.automation_jobs (status, next_attempt_at)
  where status = 'queued';
create index automation_jobs_collect_idx on public.automation_jobs (status, next_check_at)
  where status = 'waiting_sefaz';

create trigger automation_jobs_set_updated_at
before update on public.automation_jobs
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- automation_tasks
-- dedup_key = client_id|competence|document_type|operation_type
-- ---------------------------------------------------------------------
create table public.automation_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.automation_jobs (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  task_type public.task_type not null,
  status public.task_status not null default 'pending',
  competence char(7) not null,
  document_type public.document_type,
  operation_type text,
  dedup_key text,
  superseded boolean not null default false,
  external_request_id text,
  requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  retry_count integer not null default 0,
  error_message text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index automation_tasks_job_id_idx on public.automation_tasks (job_id);
create index automation_tasks_status_idx on public.automation_tasks (status);
create index automation_tasks_client_competence_idx on public.automation_tasks (client_id, competence);

-- Controle de duplicidade: só pode existir uma exportação "viva" por chave lógica.
create unique index automation_tasks_dedup_active_idx
  on public.automation_tasks (dedup_key)
  where dedup_key is not null
    and not superseded
    and status in ('pending', 'running', 'scheduled', 'processed', 'downloaded', 'completed');

create trigger automation_tasks_set_updated_at
before update on public.automation_tasks
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- automation_logs
-- ---------------------------------------------------------------------
create table public.automation_logs (
  id bigint generated always as identity primary key,
  job_id uuid references public.automation_jobs (id) on delete cascade,
  task_id uuid references public.automation_tasks (id) on delete set null,
  level public.log_level not null default 'INFO',
  step text,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index automation_logs_job_id_idx on public.automation_logs (job_id, created_at);
create index automation_logs_level_idx on public.automation_logs (level, created_at desc);

-- ---------------------------------------------------------------------
-- downloads
-- ---------------------------------------------------------------------
create table public.downloads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  job_id uuid references public.automation_jobs (id) on delete set null,
  automation_task_id uuid references public.automation_tasks (id) on delete set null,
  document_type public.document_type not null,
  competence char(7) not null,
  filename text not null,
  filepath text not null,
  size bigint not null default 0,
  checksum char(64) not null,
  downloaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint downloads_checksum_format check (checksum ~ '^[0-9a-f]{64}$')
);

create index downloads_client_id_idx on public.downloads (client_id);
create index downloads_competence_idx on public.downloads (competence);
create unique index downloads_unique_file on public.downloads (client_id, competence, document_type, checksum);

-- ---------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  client_id uuid references public.clients (id) on delete set null,
  ip text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index audit_logs_client_id_idx on public.audit_logs (client_id);

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  level text not null default 'info',
  title text not null,
  message text not null,
  link text,
  dedup_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_level check (level in ('info', 'success', 'warning', 'error'))
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create unique index notifications_dedup_idx on public.notifications (user_id, dedup_key)
  where dedup_key is not null;

-- ---------------------------------------------------------------------
-- worker_heartbeats
-- ---------------------------------------------------------------------
create table public.worker_heartbeats (
  worker_id text primary key,
  kind text not null,
  hostname text,
  status text not null default 'idle',
  current_job_id uuid references public.automation_jobs (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- app_settings
-- ---------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value, description) values
  ('collector_interval_minutes', '30'::jsonb, 'Intervalo entre consultas do Collector a pedidos aguardando SEFAZ'),
  ('collector_max_checks', '96'::jsonb, 'Número máximo de consultas antes de marcar o pedido como falho'),
  ('certificate_warning_days', '30'::jsonb, 'Dias de antecedência para alerta de vencimento de certificado')
on conflict (key) do nothing;
