-- Notas canceladas (robô 1.2.32), parte 2: as funções passam a conhecer os pedidos novos.
-- - task_document_type: pedido -> tipo de nota (a chave de duplicidade usa o tipo, então as
--   canceladas não esbarram no pedido normal do mesmo mês);
-- - create_automation_jobs_batch: aceita os pedidos de canceladas, respeitando o cadastro;
-- - retry_automation_job: "Reprocessar" também refaz os pedidos de canceladas;
-- - downloads_no_movement: canceladas sem nota não aparecem na tela Downloads.

create or replace function public.task_document_type(p_task public.task_type)
returns public.document_type
language sql
immutable
as $$
  select case p_task
    when 'NFCE_EXPORT' then 'NFCE'::public.document_type
    when 'NFE_ISSUED_EXPORT' then 'NFE_EMITIDAS'::public.document_type
    when 'NFE_RECEIVED_EXPORT' then 'NFE_RECEBIDAS'::public.document_type
    when 'NFCE_CANCELED_EXPORT' then 'NFCE_CANCELADAS'::public.document_type
    when 'NFE_ISSUED_CANCELED_EXPORT' then 'NFE_EMITIDAS_CANCELADAS'::public.document_type
    when 'NFE_RECEIVED_CANCELED_EXPORT' then 'NFE_RECEBIDAS_CANCELADAS'::public.document_type
    else null
  end;
$$;

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
    -- canceladas: só dos tipos de nota que a empresa usa (mesmas marcações do cadastro)
    if 'NFCE_CANCELED_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfce) then
      v_ops := array_append(v_ops, 'NFCE_CANCELED_EXPORT'::public.task_type);
    end if;
    if 'NFE_ISSUED_CANCELED_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfe_issued) then
      v_ops := array_append(v_ops, 'NFE_ISSUED_CANCELED_EXPORT'::public.task_type);
    end if;
    if 'NFE_RECEIVED_CANCELED_EXPORT' = any(p_operations) and (not p_respect_client_flags or v_client.uses_nfe_received) then
      v_ops := array_append(v_ops, 'NFE_RECEIVED_CANCELED_EXPORT'::public.task_type);
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
                         'NFE_ISSUED_CANCELED_EXPORT', 'NFE_RECEIVED_CANCELED_EXPORT', 'EFD_CHECK', 'MALHA_CHECK')
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

create or replace view public.downloads_no_movement
with (security_invoker = true) as
select distinct on (t.client_id, t.competence, t.document_type)
  t.id,
  t.org_id,
  t.client_id,
  t.job_id,
  t.competence,
  t.document_type,
  coalesce(t.finished_at, t.updated_at) as checked_at,
  t.external_request_id
from public.automation_tasks t
where t.task_type in ('NFCE_EXPORT', 'NFE_ISSUED_EXPORT', 'NFE_RECEIVED_EXPORT')
  and t.status = 'completed'
  and t.document_type is not null
  -- canceladas sem nota é o normal: não vira linha na tela Downloads (fica no Histórico do trabalho)
  and t.document_type in ('NFCE', 'NFE_EMITIDAS', 'NFE_RECEBIDAS')
  and (t.result ->> 'no_notes') = 'true'
  and not exists (
    select 1 from public.downloads d
    where d.client_id = t.client_id and d.competence = t.competence and d.document_type = t.document_type
  )
order by t.client_id, t.competence, t.document_type, coalesce(t.finished_at, t.updated_at) desc;
