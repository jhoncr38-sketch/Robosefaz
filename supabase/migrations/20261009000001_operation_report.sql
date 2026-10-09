-- Tela "Operação do dia": num lugar só, o que os robôs fizeram num período.
-- - trabalhos do PRÓPRIO escritório (com os registros que explicam atrasos);
-- - sessões dos robôs (do próprio escritório; o dono da plataforma vê as de todos);
-- - resumo por escritório (só para o dono, e só números: por privacidade, ninguém vê os
--   clientes e as notas de outro escritório);
-- - acontecimentos (computador ativado/desativado, escritório, cliente, usuário, certificado).
-- Só leitura.

create or replace function public.operation_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_owner boolean := public.is_platform_owner();
  v_jobs jsonb;
  v_sessions jsonb;
  v_offices jsonb;
  v_events jsonb;
begin
  if v_org is null or not public.is_active_user() then
    raise exception 'FORBIDDEN: usuário sem escritório ativo' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '8 days' then
    raise exception 'INVALID_PERIOD: período inválido (máximo 8 dias)' using errcode = '22023';
  end if;

  -- trabalhos do próprio escritório que estiveram ativos no período
  select coalesce(jsonb_agg(t order by t->>'started_at' nulls last, t->>'created_at'), '[]'::jsonb) into v_jobs
  from (
    select jsonb_build_object(
      'id', j.id,
      'client_code', c.client_code,
      'client_name', coalesce(c.trade_name, c.legal_name),
      'operations', j.operations,
      'competence', j.competence,
      'force', j.force_reschedule,
      'note_key', j.note_key is not null,
      'status', j.status,
      'attempts', j.attempts,
      'check_count', j.check_count,
      'created_at', j.created_at,
      'started_at', j.started_at,
      'finished_at', j.finished_at,
      'error_code', j.error_code,
      'message', left(coalesce(j.error_message, j.last_message, ''), 300),
      'files', (select count(*) from public.downloads d where d.job_id = j.id),
      'notes', (select coalesce(sum(d.note_count), 0) from public.downloads d where d.job_id = j.id),
      'logs', coalesce((
        select jsonb_agg(jsonb_build_object('at', l.created_at, 'level', l.level, 'step', l.step,
                                            'msg', left(l.message, 220)) order by l.created_at)
          from (
            select * from public.automation_logs l
             where l.job_id = j.id
               and l.message not like 'Screenshot%'
               and l.level <> 'DEBUG'
               and (l.level in ('WARNING', 'ERROR')
                    or l.step in ('starting', 'waiting_sefaz', 'completed', 'recovery', 'retry')
                    or l.message like 'Collector:%'
                    or l.message like 'Conferindo se a SEFAZ%'
                    or l.message like 'Navegador fechado%'
                    or l.message like '%já resolvido%'
                    or l.message like '%conferência rápida%'
                    or l.message like '%Conferência rápida%')
             order by l.created_at
             limit 80
          ) l
      ), '[]'::jsonb)
    ) as t
      from public.automation_jobs j
      join public.clients c on c.id = j.client_id
     where j.org_id = v_org
       and (
         (j.started_at is not null and j.started_at < p_to and coalesce(j.finished_at, now()) >= p_from)
         or (j.created_at >= p_from and j.created_at < p_to)
       )
     order by coalesce(j.started_at, j.created_at)
     limit 300
  ) x;

  -- sessões dos robôs (uma por execução do robô): próprio escritório; o dono vê todas
  select coalesce(jsonb_agg(s order by s->>'host', s->>'started_at'), '[]'::jsonb) into v_sessions
  from (
    select jsonb_build_object(
      'org_id', h.org_id,
      'org_name', o.name,
      'own', h.org_id = v_org,
      'worker_id', h.worker_id,
      'host', public.worker_host(h.worker_id),
      'version', h.meta ->> 'version',
      'status', h.status,
      'started_at', h.started_at,
      'last_seen_at', h.last_seen_at
    ) as s
      from public.worker_heartbeats h
      left join public.organizations o on o.id = h.org_id
     where h.started_at < p_to and h.last_seen_at >= p_from
       and (h.org_id = v_org or v_owner)
  ) y;

  -- resumo por escritório: só para o dono, só números
  if v_owner then
    select coalesce(jsonb_agg(r order by r->>'created_at'), '[]'::jsonb) into v_offices
    from (
      select jsonb_build_object(
        'id', o.id,
        'name', o.name,
        'status', o.status,
        'created_at', o.created_at,
        'own', o.id = v_org,
        'clients', (select count(*) from public.clients c where c.org_id = o.id and c.active),
        'certificates', (select count(*) from public.certificates ce where ce.org_id = o.id and ce.active),
        'certificates_expired', (select count(*) from public.certificates ce
                                  where ce.org_id = o.id and ce.active and ce.valid_until < now()),
        'users', (select count(*) from public.profiles p where p.org_id = o.id and p.active),
        'last_access', (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.user_id
                         where p.org_id = o.id),
        'robots', (select count(*) from public.devices d where d.org_id = o.id and d.status = 'active'),
        'robots_online', (select count(*) from public.worker_heartbeats h
                           where h.org_id = o.id and h.status <> 'stopped' and h.last_seen_at > now() - interval '3 minutes'),
        'jobs', (select count(*) from public.automation_jobs j where j.org_id = o.id
                  and j.started_at < p_to and coalesce(j.finished_at, now()) >= p_from),
        'jobs_completed', (select count(*) from public.automation_jobs j where j.org_id = o.id
                  and j.status = 'completed' and j.finished_at >= p_from and j.finished_at < p_to),
        'jobs_failed', (select count(*) from public.automation_jobs j where j.org_id = o.id
                  and j.status in ('failed', 'certificate_required') and j.updated_at >= p_from and j.updated_at < p_to),
        'files', (select count(*) from public.downloads d where d.org_id = o.id
                   and d.downloaded_at >= p_from and d.downloaded_at < p_to),
        'notes', (select coalesce(sum(d.note_count), 0) from public.downloads d where d.org_id = o.id
                   and d.downloaded_at >= p_from and d.downloaded_at < p_to)
      ) as r
        from public.organizations o
    ) z;
  end if;

  -- acontecimentos do período
  select coalesce(jsonb_agg(e order by e->>'at'), '[]'::jsonb) into v_events
  from (
    -- computadores ativados e desativados (próprio escritório; o dono vê todos)
    select jsonb_build_object('at', d.created_at, 'kind', 'device_on', 'org_name', o.name, 'own', d.org_id = v_org,
                              'text', format('Computador "%s" ativado', d.name)) as e
      from public.devices d join public.organizations o on o.id = d.org_id
     where d.created_at >= p_from and d.created_at < p_to and (d.org_id = v_org or v_owner)
    union all
    select jsonb_build_object('at', d.revoked_at, 'kind', 'device_off', 'org_name', o.name, 'own', d.org_id = v_org,
                              'text', format('Computador "%s" desativado', d.name))
      from public.devices d join public.organizations o on o.id = d.org_id
     where d.revoked_at >= p_from and d.revoked_at < p_to and (d.org_id = v_org or v_owner)
    union all
    -- escritórios novos (só o dono)
    select jsonb_build_object('at', o.created_at, 'kind', 'org', 'org_name', o.name, 'own', o.id = v_org,
                              'text', 'Escritório criado')
      from public.organizations o
     where v_owner and o.created_at >= p_from and o.created_at < p_to
    union all
    -- próprio escritório: com nome
    select jsonb_build_object('at', c.created_at, 'kind', 'client', 'org_name', null, 'own', true,
                              'text', format('Cliente %s %s cadastrado', c.client_code, coalesce(c.trade_name, c.legal_name)))
      from public.clients c
     where c.org_id = v_org and c.created_at >= p_from and c.created_at < p_to
    union all
    select jsonb_build_object('at', ce.created_at, 'kind', 'certificate', 'org_name', null, 'own', true,
                              'text', format('Certificado de %s cadastrado', coalesce(c.trade_name, c.legal_name)))
      from public.certificates ce join public.clients c on c.id = ce.client_id
     where ce.org_id = v_org and ce.created_at >= p_from and ce.created_at < p_to
    union all
    select jsonb_build_object('at', p.created_at, 'kind', 'user', 'org_name', null, 'own', true,
                              'text', format('Usuário %s criado', p.email))
      from public.profiles p
     where p.org_id = v_org and p.created_at >= p_from and p.created_at < p_to
    union all
    -- outros escritórios (só o dono): só quantidades
    select jsonb_build_object('at', max(c.created_at), 'kind', 'client', 'org_name', o.name, 'own', false,
                              'text', format('%s cliente(s) cadastrado(s)', count(*)))
      from public.clients c join public.organizations o on o.id = c.org_id
     where v_owner and c.org_id <> v_org and c.created_at >= p_from and c.created_at < p_to
     group by o.name
    union all
    select jsonb_build_object('at', max(p.created_at), 'kind', 'user', 'org_name', o.name, 'own', false,
                              'text', format('%s usuário(s) criado(s)', count(*)))
      from public.profiles p join public.organizations o on o.id = p.org_id
     where v_owner and p.org_id <> v_org and p.created_at >= p_from and p.created_at < p_to
     group by o.name
  ) w;

  return jsonb_build_object(
    'owner', v_owner,
    'org_id', v_org,
    'org_name', (select name from public.organizations where id = v_org),
    'now', now(),
    'jobs', v_jobs,
    'sessions', v_sessions,
    'offices', v_offices,
    'events', v_events
  );
end;
$$;

revoke execute on function public.operation_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.operation_report(timestamptz, timestamptz) to authenticated;
