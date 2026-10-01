-- "Sem movimento": o SIAT processou o pedido e não havia notas no período (lista "Processado
-- sem notas" ou ZIP vazio). Nesses casos o robô não salva arquivo, só marca a tarefa
-- (result.no_notes); a tela Downloads mostra uma linha própria, para ninguém achar que a
-- empresa ficou sem agendar.
--
-- Uma linha por cliente, competência e tipo (o resultado mais recente), só onde não há arquivo
-- baixado. security_invoker: vale o RLS de automation_tasks e downloads (só o próprio escritório).
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
  and (t.result ->> 'no_notes') = 'true'
  and not exists (
    select 1 from public.downloads d
    where d.client_id = t.client_id and d.competence = t.competence and d.document_type = t.document_type
  )
order by t.client_id, t.competence, t.document_type, coalesce(t.finished_at, t.updated_at) desc;

revoke all on public.downloads_no_movement from anon, authenticated;
grant select on public.downloads_no_movement to authenticated;
