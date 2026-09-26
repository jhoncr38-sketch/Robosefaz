-- O robô grava logs com RETURNING (supabase-py devolve a linha gravada); sem
-- permissão de leitura a gravação era recusada pelo RLS ("new row violates
-- row-level security policy"). Já aplicado na produção em 26/09/2026.
drop policy if exists device_logs_select on public.automation_logs;
create policy device_logs_select on public.automation_logs
  for select to authenticated using (org_id = public.device_org_id());
