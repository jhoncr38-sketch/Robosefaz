-- =====================================================================
-- SIAT Automation - Organizações (cada escritório isolado dos demais)
--
-- * organizations: um registro por escritório (ativo/suspenso, limite de empresas)
-- * profiles.org_id: cada usuário pertence a UM escritório;
--   profiles.is_platform_owner: o dono da plataforma (gerencia escritórios,
--   mas NÃO enxerga os dados dos clientes de outros escritórios)
-- * org_id nas tabelas de dados, preenchido automaticamente por triggers a
--   partir do cliente/job (robôs antigos continuam funcionando sem mudança)
-- * RLS: cada usuário só vê/altera dados do próprio escritório; escritório
--   suspenso perde o acesso
-- * client_code e CNPJ passam a ser únicos POR escritório
-- Todos os dados existentes vão para o escritório inicial.
-- =====================================================================

-- ---------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  max_clients integer,
  client_code_seq integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_name_not_blank check (length(trim(name)) > 0),
  constraint organizations_status check (status in ('active', 'suspended')),
  constraint organizations_max_clients check (max_clients is null or max_clients >= 0)
);

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

-- escritório inicial recebe tudo o que já existe
insert into public.organizations (name, client_code_seq)
values (
  'Escritório Jhonatan Rodrigues',
  coalesce((select max(substring(client_code from '[0-9]+$')::integer) from public.clients), 0)
);

-- ---------------------------------------------------------------------
-- profiles: escritório e dono da plataforma
-- ---------------------------------------------------------------------
alter table public.profiles
  add column org_id uuid references public.organizations (id) on delete restrict,
  add column is_platform_owner boolean not null default false;

update public.profiles set org_id = (select id from public.organizations order by created_at limit 1);

-- dono da plataforma: o primeiro administrador
update public.profiles
   set is_platform_owner = true
 where id = (select id from public.profiles where role = 'admin' order by created_at limit 1);

create index profiles_org_idx on public.profiles (org_id);

-- ---------------------------------------------------------------------
-- org_id nas tabelas de dados (backfill a partir do cliente/job)
-- ---------------------------------------------------------------------
alter table public.clients add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.certificates add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.automation_jobs add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.automation_tasks add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.automation_logs add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.downloads add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.audit_logs add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.notifications add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.worker_heartbeats add column org_id uuid references public.organizations (id) on delete cascade;

update public.clients set org_id = (select id from public.organizations order by created_at limit 1);
update public.certificates c set org_id = cl.org_id from public.clients cl where cl.id = c.client_id;
update public.automation_jobs j set org_id = cl.org_id from public.clients cl where cl.id = j.client_id;
update public.automation_tasks t set org_id = j.org_id from public.automation_jobs j where j.id = t.job_id;
update public.automation_logs l set org_id = j.org_id from public.automation_jobs j where j.id = l.job_id;
update public.downloads d set org_id = cl.org_id from public.clients cl where cl.id = d.client_id;
update public.audit_logs a set org_id = coalesce(
  (select cl.org_id from public.clients cl where cl.id = a.client_id),
  (select p.org_id from public.profiles p where p.user_id = a.user_id),
  (select id from public.organizations order by created_at limit 1));
update public.notifications n set org_id = p.org_id from public.profiles p where p.user_id = n.user_id;

alter table public.clients alter column org_id set not null;
alter table public.certificates alter column org_id set not null;
alter table public.automation_jobs alter column org_id set not null;
alter table public.automation_tasks alter column org_id set not null;
alter table public.downloads alter column org_id set not null;

create index clients_org_idx on public.clients (org_id);
create index certificates_org_idx on public.certificates (org_id);
create index automation_jobs_org_idx on public.automation_jobs (org_id, created_at desc);
create index automation_tasks_org_idx on public.automation_tasks (org_id);
create index automation_logs_org_idx on public.automation_logs (org_id, created_at desc);
create index downloads_org_idx on public.downloads (org_id, downloaded_at desc);
create index audit_logs_org_idx on public.audit_logs (org_id, created_at desc);

-- código e CNPJ únicos por escritório (antes: no banco inteiro)
alter table public.clients drop constraint if exists clients_client_code_key;
alter table public.clients drop constraint if exists clients_cnpj_key;
alter table public.clients alter column client_code drop default;
create unique index clients_org_code_key on public.clients (org_id, client_code);
create unique index clients_org_cnpj_key on public.clients (org_id, cnpj);

-- ---------------------------------------------------------------------
-- Helpers de acesso
-- ---------------------------------------------------------------------
create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.org_id from public.profiles p where p.user_id = auth.uid() and p.active limit 1;
$$;

create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_platform_owner from public.profiles p where p.user_id = auth.uid() and p.active limit 1),
    false);
$$;

-- papel efetivo: usuário ativo, com escritório, e escritório não suspenso
-- (o dono da plataforma nunca é bloqueado pela suspensão)
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
    from public.profiles p
    join public.organizations o on o.id = p.org_id
   where p.user_id = auth.uid()
     and p.active
     and (o.status = 'active' or p.is_platform_owner)
   limit 1;
$$;

-- ---------------------------------------------------------------------
-- Preenchimento automático do escritório (robôs e código antigos não mudam)
-- ---------------------------------------------------------------------
create or replace function public.clients_set_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    -- usuário só cria/move clientes no próprio escritório
    new.org_id := public.current_org_id();
  end if;
  if new.org_id is null then
    raise exception 'ORG_REQUIRED: cliente sem escritório' using errcode = '23502';
  end if;

  if tg_op = 'INSERT' then
    select * into v_org from public.organizations where id = new.org_id for update;
    if v_org.max_clients is not null then
      select count(*) into v_count from public.clients where org_id = new.org_id;
      if v_count >= v_org.max_clients then
        raise exception 'PLAN_LIMIT: o plano deste escritório permite até % empresas', v_org.max_clients
          using errcode = '23514';
      end if;
    end if;
    if new.client_code is null or new.client_code = '' then
      update public.organizations
         set client_code_seq = client_code_seq + 1
       where id = new.org_id
      returning 'CLI' || lpad(client_code_seq::text, 6, '0') into new.client_code;
    end if;
  elsif new.org_id is distinct from old.org_id and auth.role() <> 'service_role' then
    new.org_id := old.org_id;
  end if;
  return new;
end;
$$;

create trigger clients_set_org
before insert or update on public.clients
for each row execute function public.clients_set_org();

-- certificados, jobs e downloads: sempre o escritório do cliente (não dá para forjar)
create or replace function public.set_org_from_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select org_id into new.org_id from public.clients where id = new.client_id;
  if new.org_id is null then
    raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

create trigger certificates_set_org
before insert or update of client_id on public.certificates
for each row execute function public.set_org_from_client();
create trigger automation_jobs_set_org
before insert or update of client_id on public.automation_jobs
for each row execute function public.set_org_from_client();
create trigger downloads_set_org
before insert or update of client_id on public.downloads
for each row execute function public.set_org_from_client();

-- tarefas e logs: escritório do job
create or replace function public.set_org_from_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.job_id is not null then
    select org_id into new.org_id from public.automation_jobs where id = new.job_id;
  end if;
  return new;
end;
$$;

create trigger automation_tasks_set_org
before insert on public.automation_tasks
for each row execute function public.set_org_from_job();
create trigger automation_logs_set_org
before insert on public.automation_logs
for each row execute function public.set_org_from_job();

-- auditoria: escritório do cliente ou de quem fez a ação
create or replace function public.audit_logs_set_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.org_id is null and new.client_id is not null then
    select org_id into new.org_id from public.clients where id = new.client_id;
  end if;
  if new.org_id is null and new.user_id is not null then
    select org_id into new.org_id from public.profiles where user_id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger audit_logs_set_org
before insert on public.audit_logs
for each row execute function public.audit_logs_set_org();

-- notificações: escritório do destinatário
create or replace function public.notifications_set_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select org_id into new.org_id from public.profiles where user_id = new.user_id;
  return new;
end;
$$;

create trigger notifications_set_org
before insert on public.notifications
for each row execute function public.notifications_set_org();

-- profiles: só o dono da plataforma (ou a service role) muda escritório/dono
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_platform_owner() then
    new.org_id := old.org_id;
    new.is_platform_owner := old.is_platform_owner;
  end if;
  return new;
end;
$$;

create trigger profiles_guard
before update on public.profiles
for each row execute function public.profiles_guard();

-- novos usuários: escritório vem de app_metadata.org_id (definido pelo painel
-- com a service role); instalação nova: o primeiro usuário cria o escritório
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
  v_org uuid;
  v_owner boolean := false;
begin
  if not exists (select 1 from public.profiles) then
    v_role := 'admin';
    v_owner := true;
    select id into v_org from public.organizations order by created_at limit 1;
    if v_org is null then
      insert into public.organizations (name) values ('Escritório principal') returning id into v_org;
    end if;
  else
    -- papel e escritório vêm de raw_app_meta_data (só a service role altera);
    -- nunca de raw_user_meta_data, que o próprio usuário controla no signup
    v_role := coalesce(nullif(new.raw_app_meta_data ->> 'role', '')::public.user_role, 'viewer');
    v_org := nullif(new.raw_app_meta_data ->> 'org_id', '')::uuid;
    if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
      v_org := null;
    end if;
  end if;

  insert into public.profiles (user_id, name, email, role, org_id, is_platform_owner)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    v_role,
    v_org,
    v_owner
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Notificações só para o escritório certo
-- ---------------------------------------------------------------------
drop function if exists public.notify_operators(uuid, text, text, text, text, text);

create or replace function public.notify_operators(
  p_user_id uuid,
  p_level text,
  p_title text,
  p_message text,
  p_link text default null,
  p_dedup_key text default null,
  p_org_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if p_user_id is not null then
    perform public.notify_user(p_user_id, p_level, p_title, p_message, p_link, p_dedup_key);
    return;
  end if;
  if p_org_id is null then
    return;  -- sem destinatário e sem escritório: não avisa ninguém (nunca "todo mundo")
  end if;
  for r in
    select user_id from public.profiles
     where active and org_id = p_org_id and role in ('admin', 'operator')
  loop
    perform public.notify_user(r.user_id, p_level, p_title, p_message, p_link, p_dedup_key);
  end loop;
end;
$$;

create or replace function public.automation_jobs_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client text;
  v_files integer;
  v_link text := '/history/' || new.id::text;
  v_comp text := substr(new.competence, 6, 2) || '/' || substr(new.competence, 1, 4);
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select coalesce(trade_name, legal_name) into v_client from public.clients where id = new.client_id;

  if new.status = 'completed' then
    select count(*) into v_files from public.downloads where job_id = new.id;
    perform public.notify_operators(
      new.created_by, 'success', 'Automação concluída.',
      format('%s - %s: %s arquivo(s) disponível(is).', v_client, v_comp, v_files),
      v_link, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'waiting_sefaz' and old.status <> 'checking_processing' then
    perform public.notify_operators(
      new.created_by, 'info', 'Exportações agendadas.',
      format('%s - %s: aguardando processamento da SEFAZ.', v_client, v_comp),
      v_link, 'job-scheduled:' || new.id, new.org_id);
  elsif new.status = 'failed' then
    perform public.notify_operators(
      new.created_by, 'error', 'Erro ao acessar SIAT.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.error_message, new.error_code, 'Falha na automação.')),
      v_link, 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
  elsif new.status in ('manual_action_required', 'waiting_certificate') then
    perform public.notify_operators(
      new.created_by, 'warning', 'A automação está aguardando sua intervenção.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.manual_action_message, new.last_message, 'Ação manual necessária.')),
      '/queue', 'job-manual:' || new.id || ':' || coalesce(new.manual_action_requested_at::text, now()::text), new.org_id);
  elsif new.status = 'certificate_required' then
    perform public.notify_operators(
      new.created_by, 'error', 'Certificado digital necessário.',
      format('%s: nenhum certificado válido configurado.', v_client),
      '/clients/' || new.client_id, 'job-cert:' || new.id, new.org_id);
  end if;

  return new;
end;
$$;

create or replace function public.generate_certificate_expiry_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_count integer := 0;
  r record;
  v_left integer;
begin
  select coalesce((value)::text::integer, 30) into v_days
    from public.app_settings where key = 'certificate_warning_days';
  v_days := coalesce(v_days, 30);

  for r in
    select c.id, c.valid_until, cl.id as client_id, cl.org_id,
           coalesce(cl.trade_name, cl.legal_name) as client_name
      from public.certificates c
      join public.clients cl on cl.id = c.client_id
      join public.organizations o on o.id = cl.org_id
     where c.active
       and cl.active
       and o.status = 'active'
       and c.valid_until <= now() + make_interval(days => v_days)
  loop
    v_left := greatest(0, ceil(extract(epoch from (r.valid_until - now())) / 86400)::integer);
    perform public.notify_operators(
      null,
      case when v_left = 0 then 'error' else 'warning' end,
      case when v_left = 0 then 'Certificado vencido.' else 'Certificado vencendo.' end,
      case when v_left = 0
        then format('Certificado da %s está vencido.', r.client_name)
        else format('Certificado da %s vence em %s dias.', r.client_name, v_left)
      end,
      '/clients/' || r.client_id,
      'cert-exp:' || r.id || ':' || current_date,
      r.org_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- RPCs: só atuam em clientes/jobs do próprio escritório
-- ---------------------------------------------------------------------
create or replace function public.assert_same_org(p_org uuid, p_what text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if p_org is null or p_org is distinct from public.current_org_id() then
    raise exception '%_NOT_FOUND: não encontrado', p_what using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.create_automation_job(
  p_client_id uuid,
  p_competence text,
  p_operations public.task_type[],
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_start date;
  v_end date;
  v_op public.task_type;
  v_doc public.document_type;
  v_key text;
  v_ops public.task_type[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_job_id uuid;
  v_uid uuid := auth.uid();
  v_is_service boolean := auth.role() = 'service_role';
begin
  if not v_is_service and not public.can_operate() then
    raise exception 'FORBIDDEN: usuário sem permissão para iniciar automações' using errcode = '42501';
  end if;
  if p_force and not v_is_service and not public.is_admin() then
    raise exception 'FORBIDDEN: somente administradores podem forçar novo agendamento' using errcode = '42501';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_client.org_id, 'CLIENT');
  if not v_client.active then
    raise exception 'INVALID_CONFIGURATION: cliente inativo' using errcode = '22023';
  end if;

  select b.start_date, b.end_date into v_start, v_end from public.competence_bounds(p_competence) b;

  if p_operations is null or cardinality(p_operations) = 0 then
    raise exception 'INVALID_CONFIGURATION: selecione ao menos uma operação' using errcode = '22023';
  end if;

  foreach v_op in array p_operations loop
    v_doc := public.task_document_type(v_op);
    if v_doc is null then
      raise exception 'INVALID_CONFIGURATION: operação % não pode ser solicitada diretamente', v_op using errcode = '22023';
    end if;
    if v_op = any(v_ops) then
      continue;
    end if;
    v_key := public.export_dedup_key(p_client_id, p_competence, v_doc, 'EXPORT');

    if exists (
      select 1 from public.automation_tasks t
       where t.dedup_key = v_key
         and not t.superseded
         and t.status in ('pending', 'running', 'scheduled', 'processed', 'downloaded', 'completed')
    ) then
      if p_force then
        update public.automation_tasks
           set superseded = true
         where dedup_key = v_key
           and not superseded
           and status in ('pending', 'running', 'scheduled', 'processed', 'downloaded', 'completed');
        v_ops := array_append(v_ops, v_op);
      else
        v_skipped := v_skipped || jsonb_build_object(
          'operation', v_op, 'reason', 'EXPORT_ALREADY_SCHEDULED', 'message', 'Exportação já agendada.');
      end if;
    else
      v_ops := array_append(v_ops, v_op);
    end if;
  end loop;

  if cardinality(v_ops) = 0 then
    return jsonb_build_object('job_id', null, 'client_id', p_client_id, 'duplicate', true,
                              'skipped', v_skipped, 'message', 'Exportação já agendada.');
  end if;

  insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                      operations, force_reschedule, status, current_step, last_message)
  values (p_client_id, v_uid, v_client.provider, p_competence, v_start, v_end,
          v_ops, p_force, 'queued', 'queued', 'Aguardando processamento')
  returning id into v_job_id;

  foreach v_op in array v_ops loop
    v_doc := public.task_document_type(v_op);
    insert into public.automation_tasks (job_id, client_id, task_type, status, competence,
                                         document_type, operation_type, dedup_key)
    values (v_job_id, p_client_id, v_op, 'pending', p_competence, v_doc, 'EXPORT',
            public.export_dedup_key(p_client_id, p_competence, v_doc, 'EXPORT'));
  end loop;

  perform public.write_audit_log('automation.started', 'automation_job', v_job_id::text, p_client_id,
    jsonb_build_object('competence', p_competence, 'operations', v_ops, 'force', p_force, 'skipped', v_skipped));

  return jsonb_build_object('job_id', v_job_id, 'client_id', p_client_id, 'duplicate', false,
                            'operations', to_jsonb(v_ops), 'skipped', v_skipped);
end;
$$;

create or replace function public.cancel_automation_job(p_job_id uuid)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão' using errcode = '42501';
  end if;

  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND: job não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_job.org_id, 'JOB');
  if v_job.status in ('completed', 'failed', 'cancelled') then
    raise exception 'INVALID_STATE: job já finalizado (%).', v_job.status using errcode = '22023';
  end if;

  if v_job.status in ('queued', 'waiting_sefaz', 'certificate_required') or v_job.locked_by is null then
    update public.automation_jobs
       set status = 'cancelled', cancel_requested = true, finished_at = now(),
           current_step = 'cancelled', last_message = 'Cancelado pelo usuário',
           locked_at = null, locked_by = null
     where id = p_job_id
     returning * into v_job;
    update public.automation_tasks
       set status = 'cancelled', finished_at = now()
     where job_id = p_job_id and status in ('pending', 'running', 'scheduled', 'processed');
  else
    update public.automation_jobs
       set cancel_requested = true, last_message = 'Cancelamento solicitado'
     where id = p_job_id
     returning * into v_job;
  end if;

  perform public.write_audit_log('automation.cancelled', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

create or replace function public.retry_automation_job(p_job_id uuid)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
  r record;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'FORBIDDEN: somente administradores podem reprocessar tarefas' using errcode = '42501';
  end if;

  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND: job não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_job.org_id, 'JOB');
  if v_job.status not in ('failed', 'cancelled', 'certificate_required', 'manual_action_required') then
    raise exception 'INVALID_STATE: somente jobs com erro, cancelados ou aguardando intervenção podem ser reprocessados' using errcode = '22023';
  end if;

  -- Tarefas substituídas por um agendamento forçado nunca voltam a executar.
  update public.automation_tasks
     set status = 'skipped', error_message = 'Substituída por novo agendamento.'
   where job_id = p_job_id
     and superseded
     and status in ('pending', 'failed', 'cancelled', 'running', 'dry_run');

  -- Tarefas de exportação ainda não agendadas voltam para "pending".
  for r in
    select id from public.automation_tasks
     where job_id = p_job_id
       and not superseded
       and task_type in ('NFCE_EXPORT', 'NFE_ISSUED_EXPORT', 'NFE_RECEIVED_EXPORT')
       and status in ('failed', 'cancelled', 'running', 'dry_run')
  loop
    begin
      update public.automation_tasks
         set status = 'pending', error_message = null, retry_count = retry_count + 1,
             started_at = null, finished_at = null
       where id = r.id;
    exception when unique_violation then
      update public.automation_tasks
         set status = 'skipped', error_message = 'Exportação já agendada por outro job.'
       where id = r.id;
    end;
  end loop;

  update public.automation_jobs
     set status = 'queued', current_step = 'queued', progress = 0,
         attempts = 0, next_attempt_at = now(), cancel_requested = false,
         error_code = null, error_message = null, error_screenshot_path = null,
         manual_action_message = null, manual_action_requested_at = null,
         manual_action_confirmed_at = null, manual_action_confirmed_by = null,
         finished_at = null, locked_at = null, locked_by = null,
         last_message = 'Reprocessamento solicitado'
   where id = p_job_id
   returning * into v_job;

  perform public.write_audit_log('automation.retried', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

create or replace function public.confirm_manual_action(p_job_id uuid)
returns public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.automation_jobs;
begin
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão' using errcode = '42501';
  end if;

  update public.automation_jobs
     set manual_action_confirmed_at = now(),
         manual_action_confirmed_by = auth.uid(),
         last_message = 'Intervenção confirmada pelo usuário'
   where id = p_job_id
     and status in ('manual_action_required', 'waiting_certificate')
     and (auth.role() = 'service_role' or org_id = public.current_org_id())
   returning * into v_job;

  if not found then
    raise exception 'INVALID_STATE: job não está aguardando intervenção' using errcode = '22023';
  end if;

  perform public.write_audit_log('automation.manual_action_confirmed', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------
-- Painel do dono da plataforma: escritórios com números (sem dados dos clientes)
-- ---------------------------------------------------------------------
create or replace function public.platform_organizations()
returns table (
  id uuid,
  name text,
  status text,
  max_clients integer,
  notes text,
  created_at timestamptz,
  users integer,
  clients integer,
  jobs_30d integer,
  last_activity timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'FORBIDDEN: somente o dono da plataforma' using errcode = '42501';
  end if;
  return query
  select o.id, o.name, o.status, o.max_clients, o.notes, o.created_at,
         (select count(*)::integer from public.profiles p where p.org_id = o.id and p.active),
         (select count(*)::integer from public.clients c where c.org_id = o.id and c.active),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.created_at >= now() - interval '30 days'),
         (select max(j.updated_at) from public.automation_jobs j where j.org_id = o.id)
    from public.organizations o
   order by o.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- RLS: tudo por escritório
-- ---------------------------------------------------------------------
alter table public.organizations enable row level security;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists clients_select on public.clients;
drop policy if exists clients_insert on public.clients;
drop policy if exists clients_update on public.clients;
drop policy if exists clients_delete on public.clients;
drop policy if exists certificates_select on public.certificates;
drop policy if exists certificates_insert on public.certificates;
drop policy if exists certificates_update on public.certificates;
drop policy if exists certificates_delete on public.certificates;
drop policy if exists automation_jobs_select on public.automation_jobs;
drop policy if exists automation_tasks_select on public.automation_tasks;
drop policy if exists automation_logs_select on public.automation_logs;
drop policy if exists downloads_select on public.downloads;
drop policy if exists audit_logs_select on public.audit_logs;
drop policy if exists worker_heartbeats_select on public.worker_heartbeats;
drop policy if exists app_settings_update on public.app_settings;
drop policy if exists app_settings_insert on public.app_settings;

-- organizations
create policy organizations_select on public.organizations
  for select to authenticated
  using (id = public.current_org_id() or public.is_platform_owner());
create policy organizations_insert on public.organizations
  for insert to authenticated with check (public.is_platform_owner());
create policy organizations_update on public.organizations
  for update to authenticated using (public.is_platform_owner()) with check (public.is_platform_owner());

-- profiles
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or (org_id = public.current_org_id() and public.is_active_user())
    or public.is_platform_owner()
  );
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin() and org_id = public.current_org_id())
  with check (public.is_admin() and org_id = public.current_org_id());

-- clients / certificates
create policy clients_select on public.clients
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
create policy clients_insert on public.clients
  for insert to authenticated with check (public.is_admin());
create policy clients_update on public.clients
  for update to authenticated
  using (public.is_admin() and org_id = public.current_org_id())
  with check (public.is_admin() and org_id = public.current_org_id());
create policy clients_delete on public.clients
  for delete to authenticated using (public.is_admin() and org_id = public.current_org_id());

create policy certificates_select on public.certificates
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
create policy certificates_insert on public.certificates
  for insert to authenticated with check (public.is_admin() and org_id = public.current_org_id());
create policy certificates_update on public.certificates
  for update to authenticated
  using (public.is_admin() and org_id = public.current_org_id())
  with check (public.is_admin() and org_id = public.current_org_id());
create policy certificates_delete on public.certificates
  for delete to authenticated using (public.is_admin() and org_id = public.current_org_id());

-- jobs / tasks / logs / downloads (escritas do painel só via RPC)
create policy automation_jobs_select on public.automation_jobs
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
create policy automation_tasks_select on public.automation_tasks
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
create policy automation_logs_select on public.automation_logs
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
create policy downloads_select on public.downloads
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());

-- auditoria: administradores do próprio escritório
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.is_admin() and org_id = public.current_org_id());

-- robôs: do escritório (a partir da ativação por computador) ou todos, para o dono
create policy worker_heartbeats_select on public.worker_heartbeats
  for select to authenticated
  using (public.is_platform_owner() or (org_id = public.current_org_id() and public.is_active_user()));

-- parâmetros do robô: gerais da plataforma, só o dono altera
create policy app_settings_update on public.app_settings
  for update to authenticated using (public.is_platform_owner()) with check (public.is_platform_owner());
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check (public.is_platform_owner());

grant select, insert, update on public.organizations to authenticated;
revoke all on public.organizations from anon;

-- ---------------------------------------------------------------------
-- Permissões das funções novas
-- ---------------------------------------------------------------------
revoke execute on function public.notify_operators(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.notify_operators(uuid, text, text, text, text, text, uuid) to service_role;
revoke execute on function public.platform_organizations() from public, anon;
grant execute on function public.platform_organizations() to authenticated, service_role;
revoke execute on function public.assert_same_org(uuid, text) from public, anon;
grant execute on function public.current_org_id() to authenticated, service_role;
grant execute on function public.is_platform_owner() to authenticated, service_role;
