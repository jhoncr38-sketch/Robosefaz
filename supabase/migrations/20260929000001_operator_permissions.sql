-- =====================================================================
-- Operador passa a poder (decisão do produto, 26/09/2026):
-- * cadastrar e editar empresas e certificados
-- * reprocessar agendamentos com erro
-- * forçar novo agendamento
-- Excluir empresa/certificado, usuários, computadores e auditoria continuam
-- só com o administrador. Tudo sempre dentro do próprio escritório.
-- =====================================================================

drop policy if exists clients_insert on public.clients;
drop policy if exists clients_update on public.clients;
drop policy if exists certificates_insert on public.certificates;
drop policy if exists certificates_update on public.certificates;

create policy clients_insert on public.clients
  for insert to authenticated with check (public.can_operate());
create policy clients_update on public.clients
  for update to authenticated
  using (public.can_operate() and org_id = public.current_org_id())
  with check (public.can_operate() and org_id = public.current_org_id());

create policy certificates_insert on public.certificates
  for insert to authenticated with check (public.can_operate() and org_id = public.current_org_id());
create policy certificates_update on public.certificates
  for update to authenticated
  using (public.can_operate() and org_id = public.current_org_id())
  with check (public.can_operate() and org_id = public.current_org_id());

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
  -- administrador e operador criam (e forçam) agendamentos
  if not v_is_service and not public.can_operate() then
    raise exception 'FORBIDDEN: usuário sem permissão para iniciar automações' using errcode = '42501';
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
