-- NFS-e Nacional (robô 1.2.36), parte 2.
-- - nfse_cursors: o último NSU que o robô leu de cada cliente na API do ADN (a próxima busca
--   continua dali; nada é pedido duas vezes);
-- - notes: a chave da NFS-e tem 50 números (a da NF-e, 44) e a nota de serviço traz o ISS;
-- - create_nfse_fetch_jobs: o painel pede a busca (uma por cliente; ela traz tudo o que é novo,
--   de qualquer mês);
-- - fila: só robôs 1.2.36+ pegam esses trabalhos (os antigos não conhecem o tipo);
-- - Reprocessar e aviso de conclusão conhecem o pedido novo.

-- ---------------------------------------------------------------------
-- Último ponto lido de cada cliente
-- ---------------------------------------------------------------------
create table if not exists public.nfse_cursors (
  client_id uuid primary key references public.clients(id) on delete cascade,
  org_id uuid,
  last_nsu bigint not null default 0 constraint nfse_cursors_nsu_positive check (last_nsu >= 0),
  -- última busca que terminou bem e quantos documentos ela trouxe
  fetched_at timestamptz,
  last_documents integer not null default 0,
  updated_at timestamptz not null default now()
);

drop trigger if exists nfse_cursors_set_org on public.nfse_cursors;
create trigger nfse_cursors_set_org
before insert or update of client_id on public.nfse_cursors
for each row execute function public.set_org_from_client();

drop trigger if exists nfse_cursors_updated_at on public.nfse_cursors;
create trigger nfse_cursors_updated_at
before update on public.nfse_cursors
for each row execute function public.set_updated_at();

alter table public.nfse_cursors enable row level security;

drop policy if exists nfse_cursors_select on public.nfse_cursors;
create policy nfse_cursors_select on public.nfse_cursors
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());

drop policy if exists device_nfse_cursors_select on public.nfse_cursors;
create policy device_nfse_cursors_select on public.nfse_cursors
  for select to authenticated using (org_id = public.device_org_id());
drop policy if exists device_nfse_cursors_insert on public.nfse_cursors;
create policy device_nfse_cursors_insert on public.nfse_cursors
  for insert to authenticated with check (org_id = public.device_org_id());
drop policy if exists device_nfse_cursors_update on public.nfse_cursors;
create policy device_nfse_cursors_update on public.nfse_cursors
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

-- ---------------------------------------------------------------------
-- Índice das notas: chave de 50 números (NFS-e) e os dados do ISS
-- ---------------------------------------------------------------------
alter table public.notes drop constraint if exists notes_chave_format;
alter table public.notes alter column chave type text;
alter table public.notes
  add constraint notes_chave_format check (chave ~ '^[0-9]{44}$' or chave ~ '^[0-9]{50}$');

alter table public.notes
  add column if not exists iss_retido boolean,
  add column if not exists iss_valor numeric(15, 2),
  add column if not exists municipio text,
  add column if not exists servico text;

-- ---------------------------------------------------------------------
-- RPC do painel: buscar as NFS-e novas de cada cliente
-- ---------------------------------------------------------------------
create or replace function public.create_nfse_fetch_jobs(p_client_ids uuid[], p_competence text)
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
    raise exception 'FORBIDDEN: usuário sem permissão para buscar NFS-e' using errcode = '42501';
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

    -- a busca traz tudo o que é novo, de qualquer mês: basta uma na fila por cliente
    if exists (
      select 1 from public.automation_jobs j
       where j.client_id = v_id
         and 'NFSE_FETCH' = any(j.operations)
         and j.status not in ('completed', 'failed', 'cancelled')
    ) then
      v_results := v_results || jsonb_build_object('client_id', v_id, 'skipped', true, 'message', 'Busca já na fila.');
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                        operations, force_reschedule, status, current_step, last_message)
    values (v_id, v_uid, v_client.provider, p_competence, v_start, v_end,
            array['NFSE_FETCH']::public.task_type[], false, 'queued', 'queued', 'Aguardando busca de NFS-e')
    returning id into v_job_id;

    insert into public.automation_tasks (job_id, client_id, task_type, status, competence, operation_type)
    values (v_job_id, v_id, 'NFSE_FETCH', 'pending', p_competence, 'NFSE');

    perform public.write_audit_log('nfse.fetch_requested', 'automation_job', v_job_id::text, v_id,
      jsonb_build_object('competence', p_competence));

    v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', v_job_id);
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'results', v_results);
end;
$$;

revoke execute on function public.create_nfse_fetch_jobs(uuid[], text) from public, anon;
grant execute on function public.create_nfse_fetch_jobs(uuid[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Fila: NFS-e só para robôs 1.2.36+
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
  v_host text := public.worker_host(p_worker_id);
  v_efd boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 0]);
  v_malha boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 19]);
  v_key boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 34]);
  v_nfse boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 36]);
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
     and (v_malha or not ('MALHA_CHECK' = any(j.operations)))
     and (v_key or not ('NFE_KEY_EXPORT' = any(j.operations)))
     and (v_nfse or not ('NFSE_FETCH' = any(j.operations)))
     -- este computador já disse que não tem o certificado do cliente
     and not (v_host = any(j.skip_hosts))
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
-- Reprocessar: também refaz a busca de NFS-e
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
       and task_type in ('NFCE_EXPORT', 'NFE_ISSUED_EXPORT', 'NFE_RECEIVED_EXPORT', 'NFCE_CANCELED_EXPORT',
                         'NFE_ISSUED_CANCELED_EXPORT', 'NFE_RECEIVED_CANCELED_EXPORT', 'NFE_KEY_EXPORT',
                         'EFD_CHECK', 'MALHA_CHECK', 'NFSE_FETCH')
       and (status in ('failed', 'cancelled', 'running', 'dry_run')
            -- nota pela chave: o SIAT não agenda (entrega o arquivo no clique); um pedido que ficou
            -- "agendado" sem ID não existe no portal e precisa ser refeito do zero
            or (task_type = 'NFE_KEY_EXPORT' and status in ('scheduled', 'processed') and external_request_id is null))
  loop
    begin
      update public.automation_tasks
         set status = 'pending', error_message = null, retry_count = retry_count + 1,
             started_at = null, finished_at = null, requested_at = null
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
         skip_hosts = '{}',
         last_message = 'Reprocessamento solicitado'
   where id = p_job_id
  returning * into v_job;

  perform public.write_audit_log('automation.retried', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------
-- Aviso ao concluir: a busca de NFS-e leva para a tela NFS-e
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
  v_malha boolean := 'MALHA_CHECK' = any(new.operations);
  v_nfse boolean := 'NFSE_FETCH' = any(new.operations);
  v_key boolean := new.note_key is not null;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select coalesce(trade_name, legal_name) into v_client from public.clients where id = new.client_id;

  if new.status = 'completed' and v_key then
    select count(*) into v_files from public.downloads where job_id = new.id;
    perform public.notify_operators(
      new.created_by, case when v_files > 0 then 'success' else 'warning' end,
      case when v_files > 0 then 'Nota encontrada no SIAT.' else 'Nota não encontrada no SIAT.' end,
      format('%s: %s', v_client, coalesce(new.last_message, 'busca pela chave concluída.')),
      '/notes?q=' || new.note_key, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_nfse then
    perform public.notify_operators(
      new.created_by, 'success', 'Busca de NFS-e concluída.',
      format('%s: %s', v_client, coalesce(new.last_message, 'busca concluída.')),
      '/nfse', 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_malha then
    perform public.notify_operators(
      new.created_by, 'success', 'Consulta de malhas concluída.',
      format('%s: %s', v_client, coalesce(new.last_message, 'consulta concluída.')),
      '/malhas', 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_efd then
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
  elsif new.status = 'failed' and v_nfse then
    perform public.notify_operators(
      new.created_by, 'error', 'Erro ao buscar NFS-e.',
      format('%s: %s', v_client, coalesce(new.error_message, new.error_code, 'Falha na busca.')),
      v_link, 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
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
