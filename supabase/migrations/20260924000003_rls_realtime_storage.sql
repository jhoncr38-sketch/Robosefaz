-- =====================================================================
-- SIAT Automation - Row Level Security, Realtime e Storage privado
-- O worker usa a service_role (ignora RLS). O frontend usa anon + JWT.
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.certificates enable row level security;
alter table public.automation_jobs enable row level security;
alter table public.automation_tasks enable row level security;
alter table public.automation_logs enable row level security;
alter table public.downloads enable row level security;
alter table public.audit_logs enable row level security;
alter table public.notifications enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.app_settings enable row level security;

-- profiles --------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid() or public.is_active_user());

create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Usuário pode alterar o próprio nome, mas nunca o próprio papel/status.
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and role = (select p.role from public.profiles p where p.user_id = auth.uid())
    and active = (select p.active from public.profiles p where p.user_id = auth.uid())
  );

-- clients ---------------------------------------------------------------
create policy clients_select on public.clients
  for select to authenticated using (public.is_active_user());
create policy clients_insert on public.clients
  for insert to authenticated with check (public.is_admin());
create policy clients_update on public.clients
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy clients_delete on public.clients
  for delete to authenticated using (public.is_admin());

-- certificates ----------------------------------------------------------
create policy certificates_select on public.certificates
  for select to authenticated using (public.is_active_user());
create policy certificates_insert on public.certificates
  for insert to authenticated with check (public.is_admin());
create policy certificates_update on public.certificates
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy certificates_delete on public.certificates
  for delete to authenticated using (public.is_admin());

-- automation_jobs / tasks / logs ---------------------------------------
-- Escritas pelo frontend acontecem somente via RPC (security definer).
create policy automation_jobs_select on public.automation_jobs
  for select to authenticated using (public.is_active_user());
create policy automation_tasks_select on public.automation_tasks
  for select to authenticated using (public.is_active_user());
create policy automation_logs_select on public.automation_logs
  for select to authenticated using (public.is_active_user());

-- downloads -------------------------------------------------------------
create policy downloads_select on public.downloads
  for select to authenticated using (public.is_active_user());

-- audit_logs ------------------------------------------------------------
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.is_admin());

-- notifications ---------------------------------------------------------
create policy notifications_select on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- worker_heartbeats -----------------------------------------------------
create policy worker_heartbeats_select on public.worker_heartbeats
  for select to authenticated using (public.is_active_user());

-- app_settings ----------------------------------------------------------
create policy app_settings_select on public.app_settings
  for select to authenticated using (public.is_active_user());
create policy app_settings_update on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy app_settings_insert on public.app_settings
  for insert to authenticated with check (public.is_admin());

-- Grants mínimos (anon não acessa nada) ----------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant usage, select on sequence public.client_code_seq to authenticated;

-- ---------------------------------------------------------------------
-- Realtime: fila e notificações atualizam o painel em tempo real
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.automation_jobs;
    alter publication supabase_realtime add table public.automation_tasks;
    alter publication supabase_realtime add table public.automation_logs;
    alter publication supabase_realtime add table public.notifications;
    alter publication supabase_realtime add table public.worker_heartbeats;
  end if;
end;
$$;

alter table public.automation_jobs replica identity full;
alter table public.notifications replica identity full;

-- ---------------------------------------------------------------------
-- Storage privado: certificados e arquivos fiscais nunca públicos.
-- Bucket "certificates": sem policy para authenticated -> somente service_role.
-- Bucket "fiscal-downloads": leitura para usuários ativos, escrita só service_role.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('certificates', 'certificates', false),
           ('fiscal-downloads', 'fiscal-downloads', false)
    on conflict (id) do update set public = false;

    execute $p$
      create policy fiscal_downloads_read on storage.objects
        for select to authenticated
        using (bucket_id = 'fiscal-downloads' and public.is_active_user())
    $p$;
  end if;
end;
$$;
