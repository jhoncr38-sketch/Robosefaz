-- O robô registra downloads com upsert (ON CONFLICT DO UPDATE): quando o mesmo
-- arquivo já existe (ex.: agendamento forçado da mesma competência), o Postgres
-- exige permissão de UPDATE. Sem ela, o registro era recusado pelo RLS
-- ("violates row-level security policy (USING expression) for table downloads")
-- e o job ficava tentando de novo. Já aplicado na produção em 26/09/2026.
drop policy if exists device_downloads_update on public.downloads;
create policy device_downloads_update on public.downloads
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

-- a área local do robô (senha do certificado, perfil do navegador) grava
-- auditoria diretamente: com o computador ativado, só no próprio escritório
drop policy if exists device_audit_insert on public.audit_logs;
create policy device_audit_insert on public.audit_logs
  for insert to authenticated with check (org_id = public.device_org_id());
drop policy if exists device_audit_select on public.audit_logs;
create policy device_audit_select on public.audit_logs
  for select to authenticated using (org_id = public.device_org_id());
