-- =====================================================================
-- Consulta do processamento da EFD (27/09/2026)
--
-- O painel pede a consulta (create_efd_check_jobs): um job por cliente com a
-- tarefa EFD_CHECK. O robô entra no SIAT do cliente, abre o Domicílio
-- Tributário Eletrônico (DT-e), lê as notificações "EPE - EFD - Período AAAAMM"
-- da competência e grava cada declaração em efd_declarations.
--
-- Só robôs 1.2.0+ (que sabem ler o DT-e) pegam esses jobs: versões antigas
-- marcariam erro por não ter tarefa de exportação.
-- =====================================================================

create table public.efd_declarations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  job_id uuid references public.automation_jobs (id) on delete set null,
  competence char(7) not null,
  epe_number text not null,
  finalidade text,
  processed boolean,
  -- processed | alert (malha, tipo 3) | pending (tipo 2) | not_processed (tipo 1)
  situation text not null,
  processed_at timestamptz,
  received_at timestamptz,
  message_sent_at timestamptz,
  subject text,
  inconsistencies jsonb not null default '[]'::jsonb,
  raw_text text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint efd_declarations_competence_format check (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint efd_declarations_situation check (situation in ('processed', 'alert', 'pending', 'not_processed')),
  constraint efd_declarations_epe_unique unique (org_id, epe_number)
);

create index efd_declarations_client_competence_idx on public.efd_declarations (client_id, competence);
create index efd_declarations_org_competence_idx on public.efd_declarations (org_id, competence);

create trigger efd_declarations_set_updated_at
before update on public.efd_declarations
for each row execute function public.set_updated_at();

-- sempre o escritório do cliente (não dá para forjar)
create trigger efd_declarations_set_org
before insert or update of client_id on public.efd_declarations
for each row execute function public.set_org_from_client();

alter table public.efd_declarations enable row level security;

create policy efd_declarations_select on public.efd_declarations
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());

-- robô: grava com upsert (ON CONFLICT pelo número do EPE), por isso select + insert + update
create policy device_efd_select on public.efd_declarations
  for select to authenticated using (org_id = public.device_org_id());
create policy device_efd_insert on public.efd_declarations
  for insert to authenticated with check (org_id = public.device_org_id());
create policy device_efd_update on public.efd_declarations
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

-- ---------------------------------------------------------------------
-- Versão do robô a partir do sinal de vida (worker_heartbeats.meta.version)
-- ---------------------------------------------------------------------
create or replace function public.worker_version_at_least(p_worker_id text, p_min int[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when (h.meta ->> 'version') ~ '^[0-9]+\.[0-9]+\.[0-9]+'
        then string_to_array(substring(h.meta ->> 'version' from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[] >= p_min
      else false
    end
    from public.worker_heartbeats h
    where h.worker_id = p_worker_id
  ), false);
$$;

revoke execute on function public.worker_version_at_least(text, int[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Fila: consultas de EFD só para robôs 1.2.0+
-- ---------------------------------------------------------------------
create or replace function public.claim_next_job(p_worker_id text)
returns setof public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_org uuid := public.robot_scope();
  v_efd boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 0]);
begin
  select j.id into v_id
    from public.automation_jobs j
    join public.organizations o on o.id = j.org_id
   where j.status = 'queued'
     and j.next_attempt_at <= now()
     and not j.cancel_requested
     and j.locked_by is null
     and o.status = 'active'
     and (v_org is null or j.org_id = v_org)
     and (v_efd or not ('EFD_CHECK' = any(j.operations)))
     -- nunca usar o mesmo perfil de navegador (cliente) em paralelo
     and not exists (
       select 1 from public.automation_jobs other
        where other.client_id = j.client_id
          and other.id <> j.id
          and other.locked_by is not null
     )
   order by j.next_attempt_at, j.created_at
   for update of j skip locked
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

-- ---------------------------------------------------------------------
-- Pedido de consulta (botão "Consultar processamento de EFD")
-- ---------------------------------------------------------------------
create or replace function public.create_efd_check_jobs(p_client_ids uuid[], p_competence text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_start date;
  v_end date;
  v_job_id uuid;
  v_uid uuid := auth.uid();
  v_is_service boolean := auth.role() = 'service_role';
  v_results jsonb := '[]'::jsonb;
  v_created integer := 0;
  v_skipped integer := 0;
  v_id uuid;
begin
  if not v_is_service and not public.can_operate() then
    raise exception 'FORBIDDEN: usuário sem permissão para consultar a EFD' using errcode = '42501';
  end if;
  if p_client_ids is null or cardinality(p_client_ids) = 0 then
    raise exception 'INVALID_CONFIGURATION: selecione ao menos um cliente' using errcode = '22023';
  end if;

  select b.start_date, b.end_date into v_start, v_end from public.competence_bounds(p_competence) b;

  foreach v_id in array p_client_ids loop
    select * into v_client from public.clients where id = v_id;
    if not found then
      raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
    end if;
    perform public.assert_same_org(v_client.org_id, 'CLIENT');
    if not v_client.active then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'skipped', true, 'message', 'Cliente inativo.');
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- já existe consulta desta competência na fila ou em andamento
    if exists (
      select 1 from public.automation_jobs j
       where j.client_id = v_id
         and j.competence = p_competence
         and 'EFD_CHECK' = any(j.operations)
         and j.status not in ('completed', 'failed', 'cancelled')
    ) then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'skipped', true, 'message', 'Consulta já na fila.');
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                        operations, force_reschedule, status, current_step, last_message)
    values (v_id, v_uid, v_client.provider, p_competence, v_start, v_end,
            array['EFD_CHECK']::public.task_type[], false, 'queued', 'queued', 'Aguardando consulta da EFD')
    returning id into v_job_id;

    insert into public.automation_tasks (job_id, client_id, task_type, status, competence, operation_type)
    values (v_job_id, v_id, 'EFD_CHECK', 'pending', p_competence, 'EFD');

    perform public.write_audit_log('efd.check_requested', 'automation_job', v_job_id::text, v_id,
      jsonb_build_object('competence', p_competence));

    v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', v_job_id);
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'results', v_results);
end;
$$;

revoke execute on function public.create_efd_check_jobs(uuid[], text) from public, anon;
grant execute on function public.create_efd_check_jobs(uuid[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Reprocessar também recoloca a consulta de EFD na fila
-- ---------------------------------------------------------------------
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
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão para reprocessar' using errcode = '42501';
  end if;

  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND: job não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_job.org_id, 'JOB');
  if v_job.status not in ('failed', 'cancelled', 'certificate_required', 'manual_action_required') then
    raise exception 'INVALID_STATE: somente jobs com erro, cancelados ou aguardando intervenção podem ser reprocessados' using errcode = '22023';
  end if;

  update public.automation_tasks
     set status = 'skipped', error_message = 'Substituída por novo agendamento.'
   where job_id = p_job_id
     and superseded
     and status in ('pending', 'failed', 'cancelled', 'running', 'dry_run');

  for r in
    select id from public.automation_tasks
     where job_id = p_job_id
       and not superseded
       and task_type in ('NFCE_EXPORT', 'NFE_ISSUED_EXPORT', 'NFE_RECEIVED_EXPORT', 'EFD_CHECK')
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

-- ---------------------------------------------------------------------
-- Notificação ao concluir: a consulta de EFD mostra o resultado, não arquivos
-- ---------------------------------------------------------------------
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
  v_efd boolean := 'EFD_CHECK' = any(new.operations);
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select coalesce(trade_name, legal_name) into v_client from public.clients where id = new.client_id;

  if new.status = 'completed' and v_efd then
    perform public.notify_operators(
      new.created_by, 'success', 'Consulta de EFD concluída.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.last_message, 'consulta concluída.')),
      '/efd?competence=' || new.competence, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' then
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
