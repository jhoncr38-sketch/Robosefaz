-- =====================================================================
-- SIAT Automation - Computadores (robôs) por escritório, sem chave-mestra
--
-- * devices: cada computador ativado é um usuário técnico do Supabase Auth
--   (app_metadata.kind = 'device'), vinculado a UM escritório
-- * device_activation_codes: código de 8 caracteres, 30 min, uso único
--   (guardado só como SHA-256)
-- * device_org_id(): escritório do robô autenticado; computador desativado
--   ou escritório suspenso perdem o acesso na hora (conferido a cada consulta)
-- * políticas "device_*": o robô só lê/escreve dados do próprio escritório
-- * fila (claim_next_*), locks e manutenção aceitam o robô, limitados ao
--   escritório dele; a service role continua funcionando (robôs antigos)
-- =====================================================================

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  status text not null default 'active',
  robot_version text,
  created_by uuid references auth.users (id) on delete set null,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_status check (status in ('active', 'revoked')),
  constraint devices_name_not_blank check (length(trim(name)) > 0)
);

create index devices_org_idx on public.devices (org_id);

create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

create table public.device_activation_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  code_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references public.devices (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.worker_heartbeats add column device_id uuid references public.devices (id) on delete set null;

-- ---------------------------------------------------------------------
-- Identidade do robô
-- ---------------------------------------------------------------------
create or replace function public.device_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.org_id
    from public.devices d
    join public.organizations o on o.id = d.org_id
   where d.auth_user_id = auth.uid()
     and d.status = 'active'
     and o.status = 'active'
   limit 1;
$$;

create or replace function public.current_device_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.id from public.devices d where d.auth_user_id = auth.uid() and d.status = 'active' limit 1;
$$;

-- escritório em que o chamador pode agir como robô: null = service role (todos)
create or replace function public.robot_scope()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.role() = 'service_role' then
    return null;
  end if;
  v_org := public.device_org_id();
  if v_org is null then
    raise exception 'FORBIDDEN: computador não ativado ou desativado' using errcode = '42501';
  end if;
  return v_org;
end;
$$;

-- usuários técnicos dos computadores não ganham profile (não entram no painel)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
  v_org uuid;
  v_owner boolean := false;
begin
  if new.raw_app_meta_data ->> 'kind' = 'device' then
    return new;
  end if;

  if not exists (select 1 from public.profiles) then
    v_role := 'admin';
    v_owner := true;
    select id into v_org from public.organizations order by created_at limit 1;
    if v_org is null then
      insert into public.organizations (name) values ('Escritório principal') returning id into v_org;
    end if;
  else
    v_role := coalesce(nullif(new.raw_app_meta_data ->> 'role', '')::public.user_role, 'viewer');
    v_org := nullif(new.raw_app_meta_data ->> 'org_id', '')::uuid;
    if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
      v_org := null;
    end if;
  end if;

  insert into public.profiles (user_id, name, email, role, org_id, is_platform_owner)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.email,
    v_role,
    v_org,
    v_owner
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Códigos de ativação
-- ---------------------------------------------------------------------
create or replace function public.hash_activation_code(p_code text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex');
$$;

-- administrador do escritório gera o código (mostrado uma única vez)
create or replace function public.create_device_activation_code()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_raw bytea := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  v_code text := '';
  v_expires timestamptz := now() + interval '30 minutes';
  i integer;
begin
  if not public.is_admin() or public.current_org_id() is null then
    raise exception 'FORBIDDEN: somente administradores do escritório adicionam computadores' using errcode = '42501';
  end if;
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, (get_byte(v_raw, i) % 32) + 1, 1);
  end loop;
  insert into public.device_activation_codes (org_id, code_hash, created_by, expires_at)
  values (public.current_org_id(), public.hash_activation_code(v_code), auth.uid(), v_expires);
  return jsonb_build_object('code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4), 'expires_at', v_expires);
end;
$$;

-- o painel (service role) troca o código por um computador; uso único
create or replace function public.redeem_device_activation_code(p_code text, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code public.device_activation_codes;
  v_device uuid;
  v_org public.organizations;
begin
  if auth.role() <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_code
    from public.device_activation_codes
   where code_hash = public.hash_activation_code(p_code)
   for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= now() then
    raise exception 'INVALID_CODE: código inválido, expirado ou já usado' using errcode = '22023';
  end if;
  select * into v_org from public.organizations where id = v_code.org_id;
  if v_org.status <> 'active' then
    raise exception 'ORG_SUSPENDED: escritório suspenso' using errcode = '42501';
  end if;
  insert into public.devices (org_id, name, created_by)
  values (v_code.org_id, left(coalesce(nullif(trim(p_name), ''), 'Computador'), 80), v_code.created_by)
  returning id into v_device;
  update public.device_activation_codes set used_at = now(), device_id = v_device where id = v_code.id;
  return jsonb_build_object('device_id', v_device, 'org_id', v_org.id, 'org_name', v_org.name);
end;
$$;

-- administrador desativa um computador do próprio escritório (acesso cai na hora)
create or replace function public.revoke_device(p_device_id uuid)
returns public.devices
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_device public.devices;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'FORBIDDEN: somente administradores' using errcode = '42501';
  end if;
  update public.devices
     set status = 'revoked', revoked_at = now()
   where id = p_device_id
     and (auth.role() = 'service_role' or org_id = public.current_org_id())
  returning * into v_device;
  if not found then
    raise exception 'DEVICE_NOT_FOUND: computador não encontrado' using errcode = 'P0002';
  end if;
  return v_device;
end;
$$;

-- logs sem job (mensagens gerais do robô) ficam no escritório do computador
create or replace function public.set_org_from_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.job_id is not null then
    select org_id into new.org_id from public.automation_jobs where id = new.job_id;
  end if;
  if new.org_id is null then
    new.org_id := public.device_org_id();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Sinal "estou vivo": escritório/computador do robô e última vez visto
-- ---------------------------------------------------------------------
create or replace function public.worker_heartbeats_set_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device uuid := public.current_device_id();
begin
  if v_device is not null then
    new.device_id := v_device;
    new.org_id := public.device_org_id();
    update public.devices
       set last_seen_at = now(),
           robot_version = coalesce(new.meta ->> 'version', robot_version)
     where id = v_device;
  end if;
  return new;
end;
$$;

create trigger worker_heartbeats_set_device
before insert or update on public.worker_heartbeats
for each row execute function public.worker_heartbeats_set_device();

-- ---------------------------------------------------------------------
-- Fila e manutenção: robô limitado ao próprio escritório
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

create or replace function public.release_job_lock(p_job_id uuid, p_worker_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.robot_scope();
begin
  update public.automation_jobs
     set locked_at = null, locked_by = null
   where id = p_job_id
     and locked_by = p_worker_id
     and (v_org is null or org_id = v_org);
end;
$$;

create or replace function public.refresh_certificate_statuses()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_org uuid := public.robot_scope();
begin
  update public.certificates
     set status = public.compute_certificate_status(valid_until),
         last_checked_at = now()
   where status <> 'error'
     and status is distinct from public.compute_certificate_status(valid_until)
     and (v_org is null or org_id = v_org);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

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
  v_org uuid := public.robot_scope();
begin
  select coalesce((value)::text::integer, 30) into v_days
    from public.app_settings where key = 'certificate_warning_days';
  v_days := coalesce(v_days, 30);

  for r in
    select c.id, c.valid_until, cl.id as client_id, cl.org_id,
           coalesce(cl.trade_name, cl.legal_name) as client_name
      from public.certificates c
      join public.clients cl on cl.id = c.client_id
      join public.organizations o on o.id = cl.org_id
     where c.active
       and cl.active
       and o.status = 'active'
       and (v_org is null or cl.org_id = v_org)
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
      'cert-exp:' || r.id || ':' || current_date,
      r.org_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- números do dono da plataforma: inclui computadores
drop function if exists public.platform_organizations();
create or replace function public.platform_organizations()
returns table (
  id uuid,
  name text,
  status text,
  max_clients integer,
  notes text,
  created_at timestamptz,
  users integer,
  clients integer,
  devices integer,
  jobs_30d integer,
  last_activity timestamptz
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
  return query
  select o.id, o.name, o.status, o.max_clients, o.notes, o.created_at,
         (select count(*)::integer from public.profiles p where p.org_id = o.id and p.active),
         (select count(*)::integer from public.clients c where c.org_id = o.id and c.active),
         (select count(*)::integer from public.devices d where d.org_id = o.id and d.status = 'active'),
         (select count(*)::integer from public.automation_jobs j
           where j.org_id = o.id and j.created_at >= now() - interval '30 days'),
         (select max(j.updated_at) from public.automation_jobs j where j.org_id = o.id)
    from public.organizations o
   order by o.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.devices enable row level security;
alter table public.device_activation_codes enable row level security;

-- painel: administradores/usuários veem os computadores do próprio escritório
create policy devices_select on public.devices
  for select to authenticated
  using ((org_id = public.current_org_id() and public.is_active_user()) or auth.uid() = auth_user_id);
-- códigos: sem acesso direto (só pelas funções)

-- robô (usuário técnico do computador): somente o próprio escritório
create policy device_clients_select on public.clients
  for select to authenticated using (org_id = public.device_org_id());
create policy device_certificates_select on public.certificates
  for select to authenticated using (org_id = public.device_org_id());
create policy device_certificates_update on public.certificates
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

create policy device_jobs_select on public.automation_jobs
  for select to authenticated using (org_id = public.device_org_id());
create policy device_jobs_update on public.automation_jobs
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());
create policy device_jobs_delete on public.automation_jobs
  for delete to authenticated using (org_id = public.device_org_id());

create policy device_tasks_select on public.automation_tasks
  for select to authenticated using (org_id = public.device_org_id());
create policy device_tasks_insert on public.automation_tasks
  for insert to authenticated with check (org_id = public.device_org_id());
create policy device_tasks_update on public.automation_tasks
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

create policy device_logs_insert on public.automation_logs
  for insert to authenticated with check (org_id = public.device_org_id());
create policy device_logs_delete on public.automation_logs
  for delete to authenticated using (org_id = public.device_org_id());

create policy device_downloads_select on public.downloads
  for select to authenticated using (org_id = public.device_org_id());
create policy device_downloads_insert on public.downloads
  for insert to authenticated with check (org_id = public.device_org_id());
create policy device_downloads_delete on public.downloads
  for delete to authenticated using (org_id = public.device_org_id());

create policy device_heartbeats_select on public.worker_heartbeats
  for select to authenticated using (org_id = public.device_org_id());
create policy device_heartbeats_insert on public.worker_heartbeats
  for insert to authenticated with check (org_id = public.device_org_id());
create policy device_heartbeats_update on public.worker_heartbeats
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());
create policy device_heartbeats_delete on public.worker_heartbeats
  for delete to authenticated using (org_id = public.device_org_id());

-- limpeza automática (60 dias) do próprio escritório
create policy device_notifications_delete on public.notifications
  for delete to authenticated using (org_id = public.device_org_id());
create policy device_audit_delete on public.audit_logs
  for delete to authenticated
  using (org_id = public.device_org_id() and entity in ('download', 'automation_job'));

create policy device_app_settings_select on public.app_settings
  for select to authenticated using (public.device_org_id() is not null);

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
grant select on public.devices to authenticated;
revoke all on public.devices, public.device_activation_codes from anon;
revoke all on public.device_activation_codes from authenticated;

revoke execute on function public.claim_next_job(text) from public, anon;
revoke execute on function public.claim_next_collection(text) from public, anon;
revoke execute on function public.release_job_lock(uuid, text) from public, anon;
revoke execute on function public.refresh_certificate_statuses() from public, anon;
revoke execute on function public.generate_certificate_expiry_notifications() from public, anon;
grant execute on function public.claim_next_job(text) to authenticated, service_role;
grant execute on function public.claim_next_collection(text) to authenticated, service_role;
grant execute on function public.release_job_lock(uuid, text) to authenticated, service_role;
grant execute on function public.refresh_certificate_statuses() to authenticated, service_role;
grant execute on function public.generate_certificate_expiry_notifications() to authenticated, service_role;

revoke execute on function public.redeem_device_activation_code(text, text) from public, anon, authenticated;
grant execute on function public.redeem_device_activation_code(text, text) to service_role;
revoke execute on function public.create_device_activation_code() from public, anon;
grant execute on function public.create_device_activation_code() to authenticated;
revoke execute on function public.revoke_device(uuid) from public, anon;
grant execute on function public.revoke_device(uuid) to authenticated, service_role;
revoke execute on function public.platform_organizations() from public, anon;
grant execute on function public.platform_organizations() to authenticated, service_role;
grant execute on function public.device_org_id() to authenticated, service_role;
grant execute on function public.current_device_id() to authenticated, service_role;
