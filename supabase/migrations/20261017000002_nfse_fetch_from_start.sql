-- NFS-e canceladas (robô 1.2.39), parte 2: o pedido "desde o início" e a trava de versão na fila.
--
-- "Desde o início" relê a NFS-e Nacional do NSU 0 para montar os ZIPs de canceladas das notas já lidas
-- por versões anteriores (o evento tinha sido descartado). Vai no mesmo campo force_reschedule do pedido;
-- o robô não regrava o que já está nos arquivos. Só robôs 1.2.39+ pegam esse pedido: um robô antigo
-- ignoraria o "desde o início", avançaria o NSU e o arquivo de canceladas nunca seria montado.

drop function if exists public.create_nfse_fetch_jobs(uuid[], text);

create or replace function public.create_nfse_fetch_jobs(p_client_ids uuid[], p_competence text, p_from_start boolean default false)
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
            array['NFSE_FETCH']::public.task_type[], coalesce(p_from_start, false), 'queued', 'queued',
            case when coalesce(p_from_start, false) then 'Aguardando busca de NFS-e (desde o início)' else 'Aguardando busca de NFS-e' end)
    returning id into v_job_id;

    insert into public.automation_tasks (job_id, client_id, task_type, status, competence, operation_type)
    values (v_job_id, v_id, 'NFSE_FETCH', 'pending', p_competence, 'NFSE');

    perform public.write_audit_log('nfse.fetch_requested', 'automation_job', v_job_id::text, v_id,
      jsonb_build_object('competence', p_competence, 'from_start', coalesce(p_from_start, false)));

    v_results := v_results || jsonb_build_object('client_id', v_id, 'job_id', v_job_id);
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'results', v_results);
end;
$$;

revoke execute on function public.create_nfse_fetch_jobs(uuid[], text, boolean) from public, anon;
grant execute on function public.create_nfse_fetch_jobs(uuid[], text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Fila: busca "desde o início" só para robôs 1.2.39+
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
  v_emit boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 37]);
  v_nfse_full boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 39]);
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
     -- "desde o início" (force_reschedule na busca de NFS-e) exige o robô que monta os ZIPs de canceladas
     and (v_nfse_full or not ('NFSE_FETCH' = any(j.operations) and j.force_reschedule))
     and (v_emit or not (j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]))
     -- este computador já disse que não tem o certificado do cliente
     and not (v_host = any(j.skip_hosts))
     -- nunca usar o mesmo perfil de navegador (cliente) em paralelo
     and (
       j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]
       or not exists (
         select 1 from public.automation_jobs other
          where other.client_id = j.client_id
            and other.id <> j.id
            and other.locked_by is not null
       )
     )
   order by (j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]) desc, j.next_attempt_at, j.created_at
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
