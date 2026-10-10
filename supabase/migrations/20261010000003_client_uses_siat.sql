-- Empresa só de serviço (sem inscrição estadual): não usa o SIAT, só a NFS-e Nacional.
-- - clients.uses_siat: desligado, a empresa fica fora das telas do SIAT (Executar automações,
--   Malhas, EFD) e as três marcações de nota do SIAT ficam desligadas;
-- - trava no banco: nenhum pedido do SIAT (exportação, nota pela chave, EFD, malhas) é criado para
--   uma empresa sem SIAT, mesmo que a tela deixe passar. A busca de NFS-e continua valendo;
-- - aviso da NFS-e: nada quando a busca não trouxe nota nova e um aviso só por lote (10 min) quando
--   trouxe, em vez de um por cliente.

alter table public.clients add column if not exists uses_siat boolean not null default true;
comment on column public.clients.uses_siat is
  'Empresa com inscrição estadual, atendida pelo SIAT. false = só serviço (NFS-e Nacional).';

create or replace function public.clients_siat_flags()
returns trigger
language plpgsql
as $$
begin
  if not new.uses_siat then
    new.uses_nfce := false;
    new.uses_nfe_issued := false;
    new.uses_nfe_received := false;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_siat_flags on public.clients;
create trigger clients_siat_flags
before insert or update on public.clients
for each row execute function public.clients_siat_flags();

create or replace function public.automation_jobs_require_siat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from unnest(new.operations) op where op <> 'NFSE_FETCH')
     and exists (select 1 from public.clients c where c.id = new.client_id and not c.uses_siat) then
    raise exception 'NO_SIAT: empresa sem inscrição estadual não usa o SIAT (só a NFS-e Nacional)' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists automation_jobs_require_siat on public.automation_jobs;
create trigger automation_jobs_require_siat
before insert on public.automation_jobs
for each row execute function public.automation_jobs_require_siat();

-- ---------------------------------------------------------------------
-- Aviso ao concluir: NFS-e sem nota nova não avisa; com nota nova, um aviso por lote
-- ---------------------------------------------------------------------
create or replace function public.automation_jobs_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client text;
  v_files integer;
  v_link text := '/history/' || new.id::text;
  v_comp text := substr(new.competence, 6, 2) || '/' || substr(new.competence, 1, 4);
  v_efd boolean := 'EFD_CHECK' = any(new.operations);
  v_malha boolean := 'MALHA_CHECK' = any(new.operations);
  v_nfse boolean := 'NFSE_FETCH' = any(new.operations);
  v_key boolean := new.note_key is not null;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select coalesce(trade_name, legal_name) into v_client from public.clients where id = new.client_id;

  if new.status = 'completed' and v_key then
    select count(*) into v_files from public.downloads where job_id = new.id;
    perform public.notify_operators(
      new.created_by, case when v_files > 0 then 'success' else 'warning' end,
      case when v_files > 0 then 'Nota encontrada no SIAT.' else 'Nota não encontrada no SIAT.' end,
      format('%s: %s', v_client, coalesce(new.last_message, 'busca pela chave concluída.')),
      '/notes?q=' || new.note_key, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_nfse then
    -- busca sem novidade não avisa; num lote, só a primeira com novidade em cada 10 minutos avisa
    -- (o resultado de cada cliente fica na tela NFS-e Nacional)
    if coalesce(new.last_message, '') not like 'NFS-e: nenhuma nota nova.%' then
      perform public.notify_operators(
        new.created_by, 'success', 'Busca de NFS-e: há novidades.',
        format('%s: %s O resultado de cada cliente está em NFS-e Nacional.', v_client, coalesce(new.last_message, 'busca concluída.')),
        '/nfse',
        'nfse-done:' || coalesce(new.created_by::text, new.org_id::text) || ':' || (floor(extract(epoch from now()) / 600))::bigint,
        new.org_id);
    end if;
  elsif new.status = 'completed' and v_malha then
    perform public.notify_operators(
      new.created_by, 'success', 'Consulta de malhas concluída.',
      format('%s: %s', v_client, coalesce(new.last_message, 'consulta concluída.')),
      '/malhas', 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_efd then
    perform public.notify_operators(
      new.created_by, 'success', 'Consulta de EFD concluída.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.last_message, 'consulta concluída.')),
      '/efd?competence=' || new.competence, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' then
    select count(*) into v_files from public.downloads where job_id = new.id;
    perform public.notify_operators(
      new.created_by, 'success', 'Automação concluída.',
      format('%s - %s: %s arquivo(s) disponível(is).', v_client, v_comp, v_files),
      v_link, 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'waiting_sefaz' and old.status <> 'checking_processing' then
    perform public.notify_operators(
      new.created_by, 'info', 'Exportações agendadas.',
      format('%s - %s: aguardando processamento da SEFAZ.', v_client, v_comp),
      v_link, 'job-scheduled:' || new.id, new.org_id);
  elsif new.status = 'failed' and v_nfse then
    perform public.notify_operators(
      new.created_by, 'error', 'Erro ao buscar NFS-e.',
      format('%s: %s', v_client, coalesce(new.error_message, new.error_code, 'Falha na busca.')),
      v_link, 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
  elsif new.status = 'failed' then
    perform public.notify_operators(
      new.created_by, 'error', 'Erro ao acessar SIAT.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.error_message, new.error_code, 'Falha na automação.')),
      v_link, 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
  elsif new.status in ('manual_action_required', 'waiting_certificate') then
    perform public.notify_operators(
      new.created_by, 'warning', 'A automação está aguardando sua intervenção.',
      format('%s - %s: %s', v_client, v_comp, coalesce(new.manual_action_message, new.last_message, 'Ação manual necessária.')),
      '/queue', 'job-manual:' || new.id || ':' || coalesce(new.manual_action_requested_at::text, now()::text), new.org_id);
  elsif new.status = 'certificate_required' then
    perform public.notify_operators(
      new.created_by, 'error', 'Certificado digital necessário.',
      format('%s: nenhum certificado válido configurado.', v_client),
      '/clients/' || new.client_id, 'job-cert:' || new.id, new.org_id);
  end if;

  return new;
end;
$$;
