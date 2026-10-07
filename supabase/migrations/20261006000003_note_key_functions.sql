-- Nota pela chave (robô 1.2.34), parte 2.
-- - automation_jobs.note_key: a chave pedida (o robô preenche o formulário com ela);
-- - downloads.note_key: o ZIP de uma nota só (fica fora da tela Downloads do mês);
-- - request_note_from_siat: o painel cria o trabalho; a nota é "emitida" se o CNPJ do emitente
--   (na chave) é o da empresa escolhida, senão "recebida";
-- - fila: só robôs 1.2.34+ pegam esses trabalhos (os antigos não conhecem o tipo);
-- - Reprocessar e aviso de conclusão conhecem o pedido novo.

alter table public.automation_jobs
  add column if not exists note_key char(44)
  constraint automation_jobs_note_key_digits check (note_key ~ '^[0-9]{44}$');
create index if not exists automation_jobs_note_key_idx
  on public.automation_jobs (org_id, note_key) where note_key is not null;

alter table public.downloads
  add column if not exists note_key char(44)
  constraint downloads_note_key_digits check (note_key ~ '^[0-9]{44}$');

-- ---------------------------------------------------------------------
-- RPC do painel: buscar uma nota no SIAT pela chave, com o certificado da empresa escolhida
-- ---------------------------------------------------------------------
create or replace function public.request_note_from_siat(p_client_id uuid, p_chave text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_key text := regexp_replace(coalesce(p_chave, ''), '\D', '', 'g');
  v_competence text;
  v_doc public.document_type;
  v_start date;
  v_end date;
  v_job_id uuid;
  v_note_id uuid;
  v_uid uuid := auth.uid();
begin
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão para iniciar automações' using errcode = '42501';
  end if;
  if v_key !~ '^[0-9]{44}$' then
    raise exception 'INVALID_KEY: a chave de acesso tem 44 números' using errcode = '22023';
  end if;
  if substr(v_key, 21, 2) <> '55' then
    raise exception 'INVALID_KEY: só NF-e (modelo 55) pode ser buscada pela chave no SIAT' using errcode = '22023';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_client.org_id, 'CLIENT');
  if not v_client.active then
    raise exception 'INVALID_CONFIGURATION: cliente inativo' using errcode = '22023';
  end if;

  -- AAMM da chave -> competência; emitente = empresa escolhida -> nota emitida, senão recebida
  v_competence := '20' || substr(v_key, 3, 2) || '-' || substr(v_key, 5, 2);
  select b.start_date, b.end_date into v_start, v_end from public.competence_bounds(v_competence) b;
  v_doc := case when regexp_replace(v_client.cnpj, '\D', '', 'g') = substr(v_key, 7, 14)
                then 'NFE_EMITIDAS'::public.document_type else 'NFE_RECEBIDAS'::public.document_type end;

  -- já está nos arquivos desta empresa: nada a pedir
  select id into v_note_id from public.notes where client_id = p_client_id and chave = v_key limit 1;
  if v_note_id is not null then
    return jsonb_build_object('job_id', null, 'note_id', v_note_id, 'already_indexed', true);
  end if;

  -- já tem um pedido em andamento desta chave para esta empresa: devolve ele
  select id into v_job_id from public.automation_jobs
   where client_id = p_client_id and note_key = v_key
     and status not in ('completed', 'failed', 'cancelled')
   order by created_at desc limit 1;
  if v_job_id is not null then
    return jsonb_build_object('job_id', v_job_id, 'duplicate', true);
  end if;

  insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                      operations, force_reschedule, status, current_step, last_message, note_key)
  values (p_client_id, v_uid, v_client.provider, v_competence, v_start, v_end,
          array['NFE_KEY_EXPORT']::public.task_type[], false, 'queued', 'queued',
          'Aguardando o robô: nota pela chave', v_key)
  returning id into v_job_id;

  insert into public.automation_tasks (job_id, client_id, task_type, status, competence,
                                       document_type, operation_type, dedup_key)
  values (v_job_id, p_client_id, 'NFE_KEY_EXPORT', 'pending', v_competence, v_doc, 'KEY',
          public.export_dedup_key(p_client_id, v_competence, v_doc, 'KEY:' || v_key));

  perform public.write_audit_log('automation.note_requested', 'automation_job', v_job_id::text, p_client_id,
    jsonb_build_object('chave', v_key, 'document_type', v_doc));

  return jsonb_build_object('job_id', v_job_id, 'document_type', v_doc, 'competence', v_competence);
end;
$$;

grant execute on function public.request_note_from_siat(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Fila: nota pela chave só para robôs 1.2.34+ (agendamento e coleta)
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

create or replace function public.claim_next_collection(p_worker_id text)
returns setof public.automation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_org uuid := public.robot_scope();
  v_host text := public.worker_host(p_worker_id);
  v_key boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 34]);
begin
  select j.id into v_id
    from public.automation_jobs j
    join public.organizations o on o.id = j.org_id
   where j.status = 'waiting_sefaz'
     and coalesce(j.next_check_at, now()) <= now()
     and not j.cancel_requested
     and j.locked_by is null
     and o.status = 'active'
     and (v_org is null or j.org_id = v_org)
     and (v_key or not ('NFE_KEY_EXPORT' = any(j.operations)))
     and not (v_host = any(j.skip_hosts))
     and not exists (
       select 1 from public.automation_jobs other
        where other.client_id = j.client_id
          and other.id <> j.id
          and other.locked_by is not null
     )
   order by coalesce(j.next_check_at, j.created_at)
   for update of j skip locked
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

-- ---------------------------------------------------------------------
-- Reprocessar: também refaz o pedido da nota pela chave
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
                         'EFD_CHECK', 'MALHA_CHECK')
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
-- Aviso ao concluir: a nota pela chave leva direto para a tela Notas
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
