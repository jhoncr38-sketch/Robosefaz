-- =====================================================================
-- SIAT Automation - Funções de negócio, RPCs, fila e auditoria
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers de permissão (usados pelas policies de RLS)
-- ---------------------------------------------------------------------
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
    from public.profiles p
   where p.user_id = auth.uid()
     and p.active
   limit 1;
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() is not null;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;

create or replace function public.can_operate()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() in ('admin', 'operator'), false);
$$;

-- IP do cliente, quando a requisição veio pelo PostgREST.
create or replace function public.request_ip()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if v_headers is null then
    return null;
  end if;
  return coalesce(
    split_part(v_headers ->> 'x-forwarded-for', ',', 1),
    v_headers ->> 'x-real-ip',
    v_headers ->> 'cf-connecting-ip'
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Auditoria
-- ---------------------------------------------------------------------
create or replace function public.write_audit_log(
  p_action text,
  p_entity text,
  p_entity_id text,
  p_client_id uuid,
  p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (user_id, action, entity, entity_id, client_id, ip, data)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_client_id, public.request_ip(), coalesce(p_data, '{}'::jsonb));
end;
$$;

-- Diferença entre OLD e NEW (somente colunas alteradas), sem campos sensíveis.
create or replace function public.jsonb_row_diff(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    jsonb_object_agg(n.key, jsonb_build_object('old', p_old -> n.key, 'new', n.value)),
    '{}'::jsonb
  )
  from jsonb_each(p_new) n
  where (p_old -> n.key) is distinct from n.value
    and n.key not in ('updated_at', 'locked_at', 'locked_by', 'progress', 'current_step', 'last_message');
$$;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text := tg_argv[0];
  v_new jsonb;
  v_old jsonb;
  v_client uuid;
  v_id text;
  v_action text;
  v_data jsonb;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old);
  end if;

  v_id := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_client := case
    when v_entity = 'client' then v_id::uuid
    else nullif(coalesce(v_new ->> 'client_id', v_old ->> 'client_id'), '')::uuid
  end;

  if tg_op = 'INSERT' then
    v_action := v_entity || '.created';
    v_data := v_new;
  elsif tg_op = 'UPDATE' then
    v_data := public.jsonb_row_diff(v_old, v_new);
    if v_data = '{}'::jsonb then
      return new;
    end if;
    v_action := v_entity || '.updated';
  else
    v_action := v_entity || '.deleted';
    v_data := v_old;
  end if;

  insert into public.audit_logs (user_id, action, entity, entity_id, client_id, ip, data)
  values (auth.uid(), v_action, v_entity, v_id,
          case when tg_op = 'DELETE' and v_entity = 'client' then null else v_client end,
          public.request_ip(), v_data);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger clients_audit
after insert or update or delete on public.clients
for each row execute function public.audit_row_change('client');

create trigger certificates_audit
after insert or update or delete on public.certificates
for each row execute function public.audit_row_change('certificate');

create trigger profiles_audit
after update on public.profiles
for each row execute function public.audit_row_change('user');

create or replace function public.audit_download_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (user_id, action, entity, entity_id, client_id, data)
  values (null, 'download.completed', 'download', new.id::text, new.client_id,
          jsonb_build_object('filename', new.filename, 'competence', new.competence,
                             'document_type', new.document_type, 'size', new.size));
  return new;
end;
$$;

create trigger downloads_audit
after insert on public.downloads
for each row execute function public.audit_download_created();

-- ---------------------------------------------------------------------
-- Notificações
-- ---------------------------------------------------------------------
create or replace function public.notify_user(
  p_user_id uuid,
  p_level text,
  p_title text,
  p_message text,
  p_link text default null,
  p_dedup_key text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return;
  end if;
  insert into public.notifications (user_id, level, title, message, link, dedup_key)
  values (p_user_id, p_level, p_title, p_message, p_link, p_dedup_key)
  on conflict (user_id, dedup_key) where dedup_key is not null do nothing;
end;
$$;

-- Notifica um usuário específico, ou todos admins/operadores quando p_user_id é nulo.
create or replace function public.notify_operators(
  p_user_id uuid,
  p_level text,
  p_title text,
  p_message text,
  p_link text default null,
  p_dedup_key text default null
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
  for r in
    select user_id from public.profiles where active and role in ('admin', 'operator')
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
      v_link, 'job-completed:' || new.id);
  elsif new.status = 'waiting_sefaz' and old.status <> 'checking_processing' then
    perform public.notify_operators(
      new.created_by, 'info', 'Exportações agendadas.',
      format('%s - %s: aguardando processamento da SEFAZ.', v_client, v_comp),
      v_link, 'job-scheduled:' || new.id);
  elsif new.status = 'failed' then
    perform public.notify_operators(
      new.created_by, 'error', 'Erro ao acessar SIAT.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.error_message, new.error_code, 'Falha na automação.')),
      v_link, 'job-failed:' || new.id || ':' || new.attempts);
  elsif new.status in ('manual_action_required', 'waiting_certificate') then
    perform public.notify_operators(
      new.created_by, 'warning', 'A automação está aguardando sua intervenção.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.manual_action_message, new.last_message, 'Ação manual necessária.')),
      '/queue', 'job-manual:' || new.id || ':' || coalesce(new.manual_action_requested_at::text, now()::text));
  elsif new.status = 'certificate_required' then
    perform public.notify_operators(
      new.created_by, 'error', 'Certificado digital necessário.',
      format('%s: nenhum certificado válido configurado.', v_client),
      '/clients/' || new.client_id, 'job-cert:' || new.id);
  end if;

  return new;
end;
$$;

create trigger automation_jobs_notify
after update of status on public.automation_jobs
for each row execute function public.automation_jobs_notify();

-- Gera alertas de certificados vencendo (idempotente por dia).
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
    select c.id, c.valid_until, cl.id as client_id, coalesce(cl.trade_name, cl.legal_name) as client_name
      from public.certificates c
      join public.clients cl on cl.id = c.client_id
     where c.active
       and cl.active
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
      'cert-exp:' || r.id || ':' || current_date);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Competência
-- ---------------------------------------------------------------------
create or replace function public.competence_bounds(p_competence text, out start_date date, out end_date date)
language plpgsql
immutable
as $$
begin
  if p_competence !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'INVALID_COMPETENCE: competência deve estar no formato YYYY-MM' using errcode = '22023';
  end if;
  start_date := to_date(p_competence || '-01', 'YYYY-MM-DD');
  end_date := (start_date + interval '1 month' - interval '1 day')::date;
end;
$$;

create or replace function public.task_document_type(p_task public.task_type)
returns public.document_type
language sql
immutable
as $$
  select case p_task
    when 'NFCE_EXPORT' then 'NFCE'::public.document_type
    when 'NFE_ISSUED_EXPORT' then 'NFE_EMITIDAS'::public.document_type
    when 'NFE_RECEIVED_EXPORT' then 'NFE_RECEBIDAS'::public.document_type
    else null
  end;
$$;

create or replace function public.export_dedup_key(
  p_client_id uuid, p_competence text, p_document public.document_type, p_operation text
)
returns text
language sql
immutable
as $$
  select p_client_id::text || '|' || p_competence || '|' || p_document::text || '|' || p_operation;
$$;

-- ---------------------------------------------------------------------
-- RPC: criar job (com controle de duplicidade)
-- ---------------------------------------------------------------------
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

-- Lote: um job por cliente. Com p_respect_client_flags, só executa as
-- operações habilitadas no cadastro de cada cliente.
create or replace function public.create_automation_jobs_batch(
  p_client_ids uuid[],
  p_competence text,
  p_operations public.task_type[],
  p_force boolean default false,
  p_respect_client_flags boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_client public.clients;
  v_ops public.task_type[];
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão para iniciar automações' using errcode = '42501';
  end if;

  foreach v_id in array coalesce(p_client_ids, '{}') loop
    select * into v_client from public.clients where id = v_id;
    if not found then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', null, 'error', 'CLIENT_NOT_FOUND');
      continue;
    end if;

    v_ops := '{}';
    if 'NFCE_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfce) then
      v_ops := array_append(v_ops, 'NFCE_EXPORT'::public.task_type);
    end if;
    if 'NFE_ISSUED_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfe_issued) then
      v_ops := array_append(v_ops, 'NFE_ISSUED_EXPORT'::public.task_type);
    end if;
    if 'NFE_RECEIVED_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfe_received) then
      v_ops := array_append(v_ops, 'NFE_RECEIVED_EXPORT'::public.task_type);
    end if;

    if cardinality(v_ops) = 0 then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', null,
        'error', 'NO_OPERATIONS', 'message', 'Nenhuma operação habilitada para o cliente.');
      continue;
    end if;

    begin
      v_result := public.create_automation_job(v_id, p_competence, v_ops, p_force);
      v_results := v_results || v_result;
    exception when others then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', null,
        'error', split_part(sqlerrm, ':', 1), 'message', sqlerrm);
    end;
  end loop;

  return v_results;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC: cancelar / reprocessar / confirmar intervenção manual
-- ---------------------------------------------------------------------
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
   returning * into v_job;

  if not found then
    raise exception 'INVALID_STATE: job não está aguardando intervenção' using errcode = '22023';
  end if;

  perform public.write_audit_log('automation.manual_action_confirmed', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------
-- Fila do worker (somente service_role)
-- ---------------------------------------------------------------------
create or replace function public.claim_next_job(p_worker_id text)
returns setof public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select j.id into v_id
    from public.automation_jobs j
   where j.status = 'queued'
     and j.next_attempt_at <= now()
     and not j.cancel_requested
     and j.locked_by is null
     -- nunca usar o mesmo perfil de navegador (cliente) em paralelo
     and not exists (
       select 1 from public.automation_jobs o
        where o.client_id = j.client_id
          and o.id <> j.id
          and o.locked_by is not null
     )
   order by j.next_attempt_at, j.created_at
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.automation_jobs
     set status = 'starting',
         current_step = 'starting',
         locked_at = now(),
         locked_by = p_worker_id,
         attempts = attempts + 1,
         started_at = coalesce(started_at, now()),
         last_message = 'Iniciando automação'
   where id = v_id
  returning *;
end;
$$;

create or replace function public.claim_next_collection(p_worker_id text)
returns setof public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select j.id into v_id
    from public.automation_jobs j
   where j.status = 'waiting_sefaz'
     and coalesce(j.next_check_at, now()) <= now()
     and not j.cancel_requested
     and j.locked_by is null
     and not exists (
       select 1 from public.automation_jobs o
        where o.client_id = j.client_id
          and o.id <> j.id
          and o.locked_by is not null
     )
   order by coalesce(j.next_check_at, j.created_at)
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.automation_jobs
     set status = 'checking_processing',
         current_step = 'checking_processing',
         locked_at = now(),
         locked_by = p_worker_id,
         check_count = check_count + 1,
         last_message = 'Consultando processamento na SEFAZ'
   where id = v_id
  returning *;
end;
$$;

create or replace function public.release_job_lock(p_job_id uuid, p_worker_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.automation_jobs
     set locked_at = null, locked_by = null
   where id = p_job_id and locked_by = p_worker_id;
$$;

-- Libera locks de workers que morreram (sem heartbeat).
create or replace function public.release_stale_locks(p_stale_minutes integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_n integer;
begin
  update public.automation_jobs
     set status = 'waiting_sefaz', locked_at = null, locked_by = null,
         last_message = 'Lock expirado; nova consulta agendada'
   where locked_by is not null
     and locked_at < now() - make_interval(mins => p_stale_minutes)
     and status in ('checking_processing', 'download_available', 'downloading', 'organizing_files');
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  update public.automation_jobs
     set status = case when attempts > max_attempts then 'failed'::public.job_status else 'queued'::public.job_status end,
         error_code = case when attempts > max_attempts then 'WORKER_LOST' else error_code end,
         error_message = case when attempts > max_attempts then 'Worker interrompido durante a execução.' else error_message end,
         finished_at = case when attempts > max_attempts then now() else finished_at end,
         locked_at = null, locked_by = null,
         last_message = 'Lock expirado; job devolvido à fila'
   where locked_by is not null
     and locked_at < now() - make_interval(mins => p_stale_minutes)
     and status not in ('completed', 'failed', 'cancelled', 'waiting_sefaz', 'queued');
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  update public.automation_tasks t
     set status = 'pending'
    from public.automation_jobs j
   where t.job_id = j.id and j.status = 'queued' and t.status = 'running';

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Dashboard
-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'clients_active', (select count(*) from public.clients where active),
    'certificates_valid', (select count(*) from public.certificates where active and valid_until > now() + interval '30 days'),
    'certificates_expiring', (select count(*) from public.certificates where active and valid_until > now() and valid_until <= now() + interval '30 days'),
    'certificates_expired', (select count(*) from public.certificates where active and valid_until <= now()),
    'jobs_today', (select count(*) from public.automation_jobs where created_at >= date_trunc('day', now())),
    'jobs_processing', (select count(*) from public.automation_jobs where status not in ('queued', 'waiting_sefaz', 'completed', 'failed', 'cancelled', 'certificate_required')),
    'jobs_waiting_sefaz', (select count(*) from public.automation_jobs where status = 'waiting_sefaz'),
    'downloads_available', (select count(*) from public.downloads),
    'jobs_completed', (select count(*) from public.automation_jobs where status = 'completed'),
    'jobs_failed', (select count(*) from public.automation_jobs where status in ('failed', 'certificate_required')),
    'jobs_queued', (select count(*) from public.automation_jobs where status = 'queued'),
    'jobs_manual', (select count(*) from public.automation_jobs where status in ('manual_action_required', 'waiting_certificate'))
  );
$$;

-- ---------------------------------------------------------------------
-- Permissões de execução
-- ---------------------------------------------------------------------
revoke execute on function public.claim_next_job(text) from public, anon, authenticated;
revoke execute on function public.claim_next_collection(text) from public, anon, authenticated;
revoke execute on function public.release_job_lock(uuid, text) from public, anon, authenticated;
revoke execute on function public.release_stale_locks(integer) from public, anon, authenticated;
revoke execute on function public.refresh_certificate_statuses() from public, anon, authenticated;
revoke execute on function public.generate_certificate_expiry_notifications() from public, anon, authenticated;
revoke execute on function public.notify_user(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_operators(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.write_audit_log(text, text, text, uuid, jsonb) from public, anon;

grant execute on function public.claim_next_job(text) to service_role;
grant execute on function public.claim_next_collection(text) to service_role;
grant execute on function public.release_job_lock(uuid, text) to service_role;
grant execute on function public.release_stale_locks(integer) to service_role;
grant execute on function public.refresh_certificate_statuses() to service_role;
grant execute on function public.generate_certificate_expiry_notifications() to service_role;
grant execute on function public.notify_user(uuid, text, text, text, text, text) to service_role;
grant execute on function public.notify_operators(uuid, text, text, text, text, text) to service_role;

revoke execute on function public.create_automation_job(uuid, text, public.task_type[], boolean) from public, anon;
revoke execute on function public.create_automation_jobs_batch(uuid[], text, public.task_type[], boolean, boolean) from public, anon;
revoke execute on function public.cancel_automation_job(uuid) from public, anon;
revoke execute on function public.retry_automation_job(uuid) from public, anon;
revoke execute on function public.confirm_manual_action(uuid) from public, anon;
grant execute on function public.create_automation_job(uuid, text, public.task_type[], boolean) to authenticated, service_role;
grant execute on function public.create_automation_jobs_batch(uuid[], text, public.task_type[], boolean, boolean) to authenticated, service_role;
grant execute on function public.cancel_automation_job(uuid) to authenticated, service_role;
grant execute on function public.retry_automation_job(uuid) to authenticated, service_role;
grant execute on function public.confirm_manual_action(uuid) to authenticated, service_role;
grant execute on function public.dashboard_stats() to authenticated, service_role;
