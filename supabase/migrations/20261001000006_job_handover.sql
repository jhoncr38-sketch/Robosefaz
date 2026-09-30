-- Repasse entre computadores: o PC que não tem o certificado do cliente instalado devolve o
-- trabalho para outro computador do escritório, em vez de parar em "certificado necessário".
-- Ele entra em skip_hosts e não pega o mesmo trabalho de novo; o Reprocessar zera a lista.

alter table public.automation_jobs
  add column if not exists skip_hosts text[] not null default '{}';

comment on column public.automation_jobs.skip_hosts is
  'Computadores (hostname) sem o certificado do cliente instalado: não pegam este trabalho. Zerado ao reprocessar.';

-- o worker_id do robô é "<hostname>-<pid>"
create or replace function public.worker_host(p_worker_id text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(coalesce(p_worker_id, ''), '-[0-9]+$', '')
$$;

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

-- Chamado pelo robô que pegou o trabalho e não tem o certificado do cliente instalado.
-- Com outro computador do escritório que deu sinal nos últimos 7 dias e ainda não tentou,
-- devolve o trabalho (fila de agendamento ou de coleta) sem contar tentativa; ele espera
-- esse computador ligar. Sem nenhum: só anota quem tentou (o robô marca "certificado necessário").
create or replace function public.hand_over_job(p_job_id uuid, p_worker_id text, p_collect boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.robot_scope();
  v_host text := public.worker_host(p_worker_id);
  v_job public.automation_jobs;
  v_skip text[];
  v_others text[];
  v_message text;
begin
  select * into v_job from public.automation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'JOB_NOT_FOUND: job não encontrado' using errcode = 'P0002';
  end if;
  if v_org is not null and v_job.org_id <> v_org then
    raise exception 'FORBIDDEN: job de outro escritório' using errcode = '42501';
  end if;
  if v_job.locked_by is distinct from p_worker_id then
    raise exception 'INVALID_STATE: o trabalho não está com este computador' using errcode = '22023';
  end if;

  v_skip := case when v_host = any(v_job.skip_hosts) then v_job.skip_hosts else array_append(v_job.skip_hosts, v_host) end;

  select coalesce(array_agg(distinct s.host order by s.host), '{}') into v_others
    from (select coalesce(nullif(hb.hostname, ''), public.worker_host(hb.worker_id)) as host
            from public.worker_heartbeats hb
           where hb.org_id = v_job.org_id
             and hb.last_seen_at > now() - interval '7 days') s
   where s.host <> '' and not (s.host = any(v_skip));

  if cardinality(v_others) = 0 then
    update public.automation_jobs set skip_hosts = v_skip where id = p_job_id;
    return jsonb_build_object('handed_over', false, 'tried', to_jsonb(v_skip), 'waiting_for', '[]'::jsonb);
  end if;

  v_message := format('Certificado não instalado em %s; repassado para %s.', v_host, array_to_string(v_others, ', '));
  if p_collect then
    update public.automation_jobs
       set skip_hosts = v_skip, status = 'waiting_sefaz', current_step = 'waiting_sefaz', progress = 80,
           next_check_at = now(), check_count = greatest(check_count - 1, 0),
           locked_at = null, locked_by = null, last_message = v_message
     where id = p_job_id;
  else
    update public.automation_jobs
       set skip_hosts = v_skip, status = 'queued', current_step = 'queued', progress = 0,
           next_attempt_at = now(), attempts = greatest(attempts - 1, 0),
           locked_at = null, locked_by = null, last_message = v_message
     where id = p_job_id;
  end if;
  return jsonb_build_object('handed_over', true, 'tried', to_jsonb(v_skip), 'waiting_for', to_jsonb(v_others));
end;
$$;

-- Reprocessar: igual ao anterior, zerando também a lista de computadores sem o certificado
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
       and task_type in ('NFCE_EXPORT', 'NFE_ISSUED_EXPORT', 'NFE_RECEIVED_EXPORT', 'EFD_CHECK', 'MALHA_CHECK')
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
         skip_hosts = '{}',
         last_message = 'Reprocessamento solicitado'
   where id = p_job_id
   returning * into v_job;

  perform public.write_audit_log('automation.retried', 'automation_job', p_job_id::text, v_job.client_id, '{}'::jsonb);
  return v_job;
end;
$$;

revoke execute on function public.hand_over_job(uuid, text, boolean) from public, anon;
grant execute on function public.hand_over_job(uuid, text, boolean) to authenticated, service_role;
