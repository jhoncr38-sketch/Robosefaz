-- Saúde da plataforma (só o dono): robôs, versões e trabalhos de cada escritório, e avisos a cada
-- 15 minutos quando algo precisa de atenção (robô parado, desatualizado, falhas, trabalhos parados).
-- Só números de funcionamento: nenhuma nota, cliente ou dado fiscal dos escritórios (LGPD).

-- "1.2.25" -> {1,2,25} (comparação de versões)
create or replace function public.version_key(p_version text)
returns int[]
language sql
immutable
set search_path = public
as $$
  select case when p_version ~ '^[0-9]+(\.[0-9]+)*$' then string_to_array(p_version, '.')::int[] end
$$;

-- limites dos avisos (ajustáveis em app_settings)
insert into public.app_settings (key, value, description) values
  ('health_offline_hours', '2', 'Saúde: horas sem sinal de nenhum robô do escritório (dia útil, 8h às 18h) para avisar'),
  ('health_outdated_days', '3', 'Saúde: dias desde a versão nova para avisar de robô ligado que não atualizou'),
  ('health_failures_day', '5', 'Saúde: falhas no dia para avisar'),
  ('health_min_success', '0.8', 'Saúde: taxa mínima de sucesso nos últimos 7 dias (com 10+ trabalhos)'),
  ('health_stuck_hours', '6', 'Saúde: horas aguardando a SEFAZ para o trabalho contar como parado')
on conflict (key) do nothing;

create or replace function public.health_setting(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (s.value #>> '{}')::numeric from public.app_settings s where s.key = p_key), p_default)
$$;

-- números de cada escritório (uso interno: a tela chama platform_health; o aviso, a verificação)
create or replace function public.platform_health_data()
returns table (
  org_id uuid,
  name text,
  status text,
  clients integer,
  max_clients integer,
  latest_version text,
  robots jsonb,
  hours_since_signal numeric,
  completed_7d integer,
  failed_7d integer,
  failed_today integer,
  stuck integer,
  waiting_person integer,
  no_certificate integer,
  failures_by_code jsonb,
  certs_expiring integer,
  certs_expired integer,
  last_activity timestamptz,
  limits jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_latest text;
  v_latest_since timestamptz;
  v_outdated_days numeric := public.health_setting('health_outdated_days', 3);
  v_stuck_hours numeric := public.health_setting('health_stuck_hours', 6);
  v_today date := (now() at time zone 'America/Fortaleza')::date;
begin
  -- versão mais nova em uso na plataforma e desde quando ela existe
  select d.robot_version into v_latest
    from public.devices d
   where d.status = 'active' and public.version_key(d.robot_version) is not null
   order by public.version_key(d.robot_version) desc
   limit 1;
  select min(hb.started_at) into v_latest_since
    from public.worker_heartbeats hb
   where hb.meta ->> 'version' = v_latest;
  v_latest_since := coalesce(v_latest_since, now());

  return query
  select o.id, o.name, o.status,
         (select count(*)::integer from public.clients c where c.org_id = o.id and c.active),
         o.max_clients,
         v_latest,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'name', d.name,
                    'version', d.robot_version,
                    'last_seen_at', d.last_seen_at,
                    -- o robô manda sinal a cada 30 s: até 2 min sem sinal ainda está ligado
                    'online', coalesce(d.last_seen_at > now() - interval '2 minutes', false),
                    'outdated', v_latest is not null
                      and public.version_key(d.robot_version) < public.version_key(v_latest)
                      and now() - v_latest_since > make_interval(days => v_outdated_days::int)
                  ) order by d.name)
             from public.devices d
            where d.org_id = o.id and d.status = 'active'), '[]'::jsonb),
         (select round((extract(epoch from now() - max(d.last_seen_at)) / 3600)::numeric, 1)
            from public.devices d where d.org_id = o.id and d.status = 'active'),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status = 'completed' and j.created_at >= now() - interval '7 days'),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status in ('failed', 'certificate_required')
             and j.created_at >= now() - interval '7 days'),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status in ('failed', 'certificate_required')
             and (coalesce(j.finished_at, j.updated_at) at time zone 'America/Fortaleza')::date = v_today),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status = 'waiting_sefaz'
             and now() - coalesce(j.started_at, j.created_at) > make_interval(hours => v_stuck_hours::int)),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status in ('manual_action_required', 'waiting_certificate')),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.status = 'certificate_required'),
         coalesce((
           select jsonb_object_agg(x.code, x.n)
             from (select coalesce(j.error_code, 'SEM_CODIGO') as code, count(*)::integer as n
                     from public.automation_jobs j
                    where j.org_id = o.id and j.status in ('failed', 'certificate_required')
                      and j.created_at >= now() - interval '7 days'
                    group by 1) x), '{}'::jsonb),
         (select count(*)::integer from public.certificates ce
            join public.clients c on c.id = ce.client_id and c.active
           where ce.org_id = o.id and ce.status = 'expiring'),
         (select count(*)::integer from public.certificates ce
            join public.clients c on c.id = ce.client_id and c.active
           where ce.org_id = o.id and ce.status = 'expired'),
         (select max(j.updated_at) from public.automation_jobs j where j.org_id = o.id),
         jsonb_build_object(
           'offline_hours', public.health_setting('health_offline_hours', 2),
           'outdated_days', v_outdated_days,
           'failures_day', public.health_setting('health_failures_day', 5),
           'min_success', public.health_setting('health_min_success', 0.8),
           'stuck_hours', v_stuck_hours
         )
    from public.organizations o
   order by o.created_at;
end;
$$;

-- tela "Saúde" (Escritórios): só o dono da plataforma
create or replace function public.platform_health()
returns table (
  org_id uuid,
  name text,
  status text,
  clients integer,
  max_clients integer,
  latest_version text,
  robots jsonb,
  hours_since_signal numeric,
  completed_7d integer,
  failed_7d integer,
  failed_today integer,
  stuck integer,
  waiting_person integer,
  no_certificate integer,
  failures_by_code jsonb,
  certs_expiring integer,
  certs_expired integer,
  last_activity timestamptz,
  limits jsonb
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
  return query select * from public.platform_health_data();
end;
$$;

-- avisos para o dono (sino do painel), sem repetir; roda a cada 15 minutos (pg_cron).
-- p_now: só para testes (horário comercial é dia útil, das 8h às 18h, horário do Piauí)
create or replace function public.generate_platform_alerts(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  robot jsonb;
  v_owner uuid;
  v_now timestamp := p_now at time zone 'America/Fortaleza';
  v_business boolean := extract(isodow from v_now) between 1 and 5 and extract(hour from v_now) between 8 and 17;
  v_day text := to_char(v_now, 'YYYY-MM-DD');
  v_total integer;
  v_before integer;
  v_after integer;
begin
  -- sinais antigos dos robôs (uma linha por vez que o robô liga)
  delete from public.worker_heartbeats where last_seen_at < now() - interval '30 days';

  select count(*) into v_before from public.notifications where dedup_key like 'health:%';

  for r in select * from public.platform_health_data() h where h.status = 'active' loop
    for v_owner in select p.user_id from public.profiles p where p.is_platform_owner and p.active loop
      -- robô parado: nenhum computador do escritório dá sinal, em horário comercial
      if v_business and jsonb_array_length(r.robots) > 0
         and r.hours_since_signal >= (r.limits ->> 'offline_hours')::numeric then
        perform public.notify_user(v_owner, 'warning', 'Robô parado: ' || r.name,
          format('Nenhum computador do escritório %s dá sinal há %s h.', r.name, r.hours_since_signal),
          '/organizations?aba=saude', format('health:offline:%s:%s', r.org_id, v_day));
      end if;

      -- robô ligado que não atualizou para a versão nova
      for robot in select * from jsonb_array_elements(r.robots) loop
        if (robot ->> 'outdated')::boolean
           and (robot ->> 'last_seen_at')::timestamptz > now() - interval '1 day' then
          perform public.notify_user(v_owner, 'warning', 'Robô desatualizado: ' || r.name,
            format('O computador %s está na versão %s (a mais nova é %s). A atualização automática pode estar falhando.',
                   robot ->> 'name', coalesce(robot ->> 'version', '?'), r.latest_version),
            '/organizations?aba=saude',
            format('health:outdated:%s:%s:%s', r.org_id, robot ->> 'name', r.latest_version));
        end if;
      end loop;

      -- falhas: muitas no dia ou taxa de sucesso baixa na semana
      v_total := r.completed_7d + r.failed_7d;
      if r.failed_today >= (r.limits ->> 'failures_day')::numeric
         or (v_total >= 10 and r.completed_7d::numeric / v_total < (r.limits ->> 'min_success')::numeric) then
        perform public.notify_user(v_owner, 'error', 'Falhas no robô: ' || r.name,
          format('%s falha(s) hoje; %s de %s trabalho(s) concluídos nos últimos 7 dias.', r.failed_today, r.completed_7d, v_total),
          '/organizations?aba=saude', format('health:failures:%s:%s', r.org_id, v_day));
      end if;

      -- trabalhos parados aguardando a SEFAZ
      if r.stuck > 0 then
        perform public.notify_user(v_owner, 'warning', 'Trabalhos parados: ' || r.name,
          format('%s trabalho(s) aguardando a SEFAZ há mais de %s h.', r.stuck, r.limits ->> 'stuck_hours'),
          '/organizations?aba=saude', format('health:stuck:%s:%s', r.org_id, v_day));
      end if;
    end loop;
  end loop;

  select count(*) into v_after from public.notifications where dedup_key like 'health:%';
  return v_after - v_before;
end;
$$;

revoke execute on function public.platform_health_data() from public, anon, authenticated;
revoke execute on function public.generate_platform_alerts(timestamptz) from public, anon, authenticated;
revoke execute on function public.platform_health() from public, anon;
grant execute on function public.platform_health() to authenticated, service_role;

-- verificação a cada 15 minutos dentro do banco (pg_cron); sem ele (ex.: testes), só não agenda
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    execute $sql$select cron.schedule('jr-platform-health', '*/15 * * * *', 'select public.generate_platform_alerts()')$sql$;
  end if;
end
$cron$;
