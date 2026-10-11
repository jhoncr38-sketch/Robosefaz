-- Emissão de NFS-e pela API da prefeitura de Teresina (robô 1.2.37), parte 2.
-- - notes: os códigos do serviço de cada NFS-e (o painel monta a lista de serviços do cliente por eles)
--   e se a nota serve de modelo para emitir (emit_model, avaliado pelo robô ao indexar);
-- - organizations.nfse_emit_enabled: a emissão é ligada escritório por escritório, pelo dono da plataforma;
-- - nfse_emissions: uma linha por nota pedida (pedido, conferência, andamento, resultado, cancelamento);
-- - create_nfse_emission / request_nfse_cancel: o painel pede; o robô 1.2.37+ executa;
-- - nfse_emission_begin / nfse_emission_bump_number: numeração própria da API (série 10001), uma
--   sequência por cliente e ambiente, sem repetir número;
-- - fila, Reprocessar e avisos conhecem os pedidos novos.
--
-- A emissão é sempre confirmada por uma pessoa no painel: o banco só registra o que ela confirmou.

-- ---------------------------------------------------------------------
-- Índice das notas: códigos do serviço da NFS-e
-- ---------------------------------------------------------------------
alter table public.notes
  add column if not exists c_trib_nac text,
  add column if not exists c_trib_mun text,
  add column if not exists c_nbs text,
  add column if not exists servico_nome text,
  add column if not exists c_loc_emi text,
  -- 'ok': serve de modelo para qualquer tomador; 'mesmo_tomador': só para o tomador da própria nota
  -- (obra ou ISS retido); outro valor: o motivo de não servir (fora do Simples, outro município...)
  add column if not exists emit_model text;

-- lista de serviços e de tomadores do cliente (tela Emitir NFS-e)
create index if not exists notes_client_nfse_prestadas_idx
  on public.notes (client_id, emitida_em desc) where document_type = 'NFSE_PRESTADAS';

-- ---------------------------------------------------------------------
-- A emissão é ligada por escritório
-- ---------------------------------------------------------------------
alter table public.organizations add column if not exists nfse_emit_enabled boolean not null default false;

create or replace function public.nfse_emit_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select o.nfse_emit_enabled from public.organizations o where o.id = public.current_org_id()), false);
$$;
revoke execute on function public.nfse_emit_enabled() from public, anon;
grant execute on function public.nfse_emit_enabled() to authenticated, service_role;

create or replace function public.set_org_nfse_emit(p_org_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (auth.role() = 'service_role' or public.is_platform_owner()) then
    raise exception 'FORBIDDEN: só o dono da plataforma liga a emissão de NFS-e' using errcode = '42501';
  end if;
  update public.organizations set nfse_emit_enabled = coalesce(p_enabled, false) where id = p_org_id;
  if not found then
    raise exception 'ORG_NOT_FOUND: escritório não encontrado' using errcode = 'P0002';
  end if;
  perform public.write_audit_log('nfse.emit_' || case when p_enabled then 'enabled' else 'disabled' end,
    'organization', p_org_id::text, null, '{}'::jsonb);
  return true;
end;
$$;
revoke execute on function public.set_org_nfse_emit(uuid, boolean) from public, anon;
grant execute on function public.set_org_nfse_emit(uuid, boolean) to authenticated, service_role;

-- empresas do escritório que têm ao menos uma NFS-e prestada que serve de modelo (tela Emitir NFS-e)
create or replace function public.nfse_emit_clients()
returns table (client_id uuid, notas bigint, ultima timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.client_id, count(*), max(n.emitida_em)
    from public.notes n
   where n.org_id = public.current_org_id()
     and public.is_active_user()
     and n.document_type = 'NFSE_PRESTADAS'
     and n.emit_model in ('ok', 'mesmo_tomador')
   group by n.client_id;
$$;
revoke execute on function public.nfse_emit_clients() from public, anon;
grant execute on function public.nfse_emit_clients() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Uma linha por nota pedida
-- ---------------------------------------------------------------------
create table if not exists public.nfse_emissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ambiente de teste da prefeitura (nota sem valor fiscal): só o dono da plataforma pede
  test_env boolean not null default false,
  -- de onde veio o preenchimento: pedido lido pela IA, nota repetida ou digitado
  source text not null default 'manual',
  request_text text,
  -- nota real do cliente de onde o robô copia o serviço e a tributação
  model_chave text not null,
  -- tomador: de uma nota anterior (toma_chave), novo (toma) ou nenhum
  toma_chave text,
  toma jsonb,
  toma_doc text,
  toma_nome text,
  c_trib_nac text not null,
  c_trib_mun text not null,
  servico_nome text,
  description text not null,
  amount numeric(15, 2) not null,
  competence text not null,
  status text not null default 'queued',
  job_id uuid references public.automation_jobs(id) on delete set null,
  -- numeração da DPS (série da API) e resultado
  serie text,
  n_dps bigint,
  id_dps text,
  send_started_at timestamptz,
  chave text,
  numero bigint,
  issued_at timestamptz,
  errors jsonb not null default '[]'::jsonb,
  last_message text,
  steps jsonb not null default '{}'::jsonb,
  nfse_xml text,
  -- cancelamento
  cancel_status text,
  cancel_job_id uuid references public.automation_jobs(id) on delete set null,
  cancel_reason_code smallint,
  cancel_reason text,
  cancel_requested_by uuid,
  cancel_requested_at timestamptz,
  cancel_errors jsonb not null default '[]'::jsonb,
  canceled_at timestamptz,
  constraint nfse_emissions_source check (source in ('ai', 'repeat', 'manual')),
  constraint nfse_emissions_status check (status in ('queued', 'processing', 'issued', 'rejected', 'failed', 'canceled')),
  constraint nfse_emissions_cancel_status check (cancel_status is null or cancel_status in ('requested', 'processing', 'rejected')),
  constraint nfse_emissions_model_chave check (model_chave ~ '^[0-9]{50}$'),
  constraint nfse_emissions_toma_chave check (toma_chave is null or toma_chave ~ '^[0-9]{50}$'),
  constraint nfse_emissions_chave check (chave is null or chave ~ '^[0-9]{50}$'),
  constraint nfse_emissions_amount check (amount > 0 and amount < 100000000),
  constraint nfse_emissions_description check (length(trim(description)) between 3 and 2000),
  constraint nfse_emissions_competence check (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint nfse_emissions_one_taker check (toma_chave is null or toma is null)
);

-- a mesma DPS (cliente, ambiente, série, número) nunca é usada duas vezes
create unique index if not exists nfse_emissions_dps_unique
  on public.nfse_emissions (client_id, test_env, serie, n_dps) where n_dps is not null;
create index if not exists nfse_emissions_org_created_idx on public.nfse_emissions (org_id, created_at desc);
create index if not exists nfse_emissions_client_idx on public.nfse_emissions (client_id, created_at desc);
create index if not exists nfse_emissions_job_idx on public.nfse_emissions (job_id);
create index if not exists nfse_emissions_cancel_job_idx on public.nfse_emissions (cancel_job_id) where cancel_job_id is not null;

drop trigger if exists nfse_emissions_set_org on public.nfse_emissions;
create trigger nfse_emissions_set_org
before insert or update of client_id on public.nfse_emissions
for each row execute function public.set_org_from_client();

drop trigger if exists nfse_emissions_updated_at on public.nfse_emissions;
create trigger nfse_emissions_updated_at
before update on public.nfse_emissions
for each row execute function public.set_updated_at();

alter table public.nfse_emissions enable row level security;

-- o painel só lê; quem grava é o RPC (pedido) e o robô do escritório (andamento e resultado)
drop policy if exists nfse_emissions_select on public.nfse_emissions;
create policy nfse_emissions_select on public.nfse_emissions
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());

drop policy if exists device_nfse_emissions_select on public.nfse_emissions;
create policy device_nfse_emissions_select on public.nfse_emissions
  for select to authenticated using (org_id = public.device_org_id());
drop policy if exists device_nfse_emissions_update on public.nfse_emissions;
create policy device_nfse_emissions_update on public.nfse_emissions
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());

grant select, update on public.nfse_emissions to authenticated;
revoke all on public.nfse_emissions from anon;

-- o painel acompanha o andamento em tempo real
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'nfse_emissions') then
    alter publication supabase_realtime add table public.nfse_emissions;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPC do painel: pedir a emissão (depois da conferência e da confirmação de quem pediu)
-- ---------------------------------------------------------------------
create or replace function public.create_nfse_emission(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_service boolean := auth.role() = 'service_role';
  v_client public.clients;
  v_client_id uuid := nullif(p->>'client_id', '')::uuid;
  v_test boolean := coalesce((p->>'test_env')::boolean, false);
  v_source text := coalesce(nullif(p->>'source', ''), 'manual');
  v_model public.notes;
  v_taker public.notes;
  v_toma jsonb := case when jsonb_typeof(p->'toma') = 'object' then p->'toma' else null end;
  v_toma_chave text := nullif(p->>'toma_chave', '');
  v_toma_doc text;
  v_toma_nome text;
  v_description text := trim(regexp_replace(coalesce(p->>'description', ''), '\s+', ' ', 'g'));
  v_amount numeric(15, 2);
  v_competence text := coalesce(nullif(p->>'competence', ''), to_char(now() at time zone 'America/Fortaleza', 'YYYY-MM'));
  v_today text := to_char(now() at time zone 'America/Fortaleza', 'YYYY-MM');
  v_start date;
  v_end date;
  v_job_id uuid;
  v_id uuid;
begin
  if not v_is_service and not public.can_operate() then
    raise exception 'FORBIDDEN: usuário sem permissão para emitir NFS-e' using errcode = '42501';
  end if;
  if v_client_id is null then
    raise exception 'INVALID_CONFIGURATION: escolha a empresa que vai emitir' using errcode = '22023';
  end if;
  select * into v_client from public.clients where id = v_client_id;
  if not found then
    raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_client.org_id, 'CLIENT');
  if not v_client.active then
    raise exception 'INVALID_CONFIGURATION: cliente inativo' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations o where o.id = v_client.org_id and o.nfse_emit_enabled) then
    raise exception 'EMIT_DISABLED: a emissão de NFS-e não está ligada para este escritório' using errcode = '42501';
  end if;
  if v_test and not (v_is_service or public.is_platform_owner()) then
    raise exception 'FORBIDDEN: o ambiente de teste é só para o dono da plataforma' using errcode = '42501';
  end if;
  if v_source not in ('ai', 'repeat', 'manual') then
    raise exception 'INVALID_CONFIGURATION: origem do pedido inválida' using errcode = '22023';
  end if;

  -- nota-modelo: uma NFS-e que o próprio cliente já emitiu (o serviço e a tributação saem dela)
  select * into v_model from public.notes n
   where n.client_id = v_client_id and n.document_type = 'NFSE_PRESTADAS' and n.chave = p->>'model_chave'
   limit 1;
  if not found then
    raise exception 'INVALID_CONFIGURATION: a nota-modelo não é uma NFS-e emitida por este cliente' using errcode = '22023';
  end if;
  if coalesce(v_model.c_trib_nac, '') = '' or coalesce(v_model.c_trib_mun, '') = '' then
    raise exception 'INVALID_CONFIGURATION: a nota-modelo ainda não tem o código do serviço no índice (aguarde o robô reindexar)' using errcode = '22023';
  end if;
  if coalesce(v_model.emit_model, '') not in ('ok', 'mesmo_tomador') then
    raise exception 'INVALID_CONFIGURATION: esta nota não serve de modelo para emitir pelo sistema (%)',
      coalesce(v_model.emit_model, 'ainda não avaliada pelo robô') using errcode = '22023';
  end if;

  -- tomador: copiado de uma nota anterior, novo ou nenhum
  if v_toma_chave is not null then
    select * into v_taker from public.notes n
     where n.client_id = v_client_id and n.document_type = 'NFSE_PRESTADAS' and n.chave = v_toma_chave
     limit 1;
    if not found or coalesce(v_taker.dest_doc, '') = '' then
      raise exception 'INVALID_CONFIGURATION: a nota do tomador não é deste cliente' using errcode = '22023';
    end if;
    v_toma := null;
    v_toma_doc := v_taker.dest_doc;
    v_toma_nome := v_taker.dest_nome;
  elsif v_toma is not null then
    v_toma_doc := regexp_replace(coalesce(v_toma->>'doc', ''), '[^0-9A-Za-z]', '', 'g');
    v_toma_nome := trim(coalesce(v_toma->>'nome', ''));
    if length(v_toma_doc) not in (11, 14) then
      raise exception 'INVALID_TAKER: informe o CNPJ ou o CPF do tomador' using errcode = '22023';
    end if;
    if length(v_toma_nome) < 2
       or coalesce(v_toma->>'cmun', '') !~ '^[0-9]{7}$'
       or regexp_replace(coalesce(v_toma->>'cep', ''), '[^0-9]', '', 'g') !~ '^[0-9]{8}$'
       or length(trim(coalesce(v_toma->>'logradouro', ''))) < 1
       or length(trim(coalesce(v_toma->>'numero', ''))) < 1
       or length(trim(coalesce(v_toma->>'bairro', ''))) < 1 then
      raise exception 'INVALID_TAKER: preencha nome, município, CEP, logradouro, número e bairro do tomador' using errcode = '22023';
    end if;
    v_toma := jsonb_build_object(
      'doc', v_toma_doc, 'nome', v_toma_nome, 'cmun', v_toma->>'cmun',
      'cep', regexp_replace(v_toma->>'cep', '[^0-9]', '', 'g'),
      'logradouro', trim(v_toma->>'logradouro'), 'numero', trim(v_toma->>'numero'),
      'complemento', nullif(trim(coalesce(v_toma->>'complemento', '')), ''), 'bairro', trim(v_toma->>'bairro'));
  end if;

  -- obra e ISS retido valem para aquele tomador: a nota só é repetida para ele
  if v_model.emit_model = 'mesmo_tomador' and coalesce(v_toma_doc, '') <> coalesce(v_model.dest_doc, '') then
    raise exception 'INVALID_CONFIGURATION: este serviço (obra ou ISS retido) só pode ser repetido para o mesmo tomador da nota-modelo' using errcode = '22023';
  end if;

  if length(v_description) not between 3 and 2000 then
    raise exception 'INVALID_CONFIGURATION: escreva a descrição do serviço' using errcode = '22023';
  end if;
  begin
    v_amount := round((p->>'amount')::numeric, 2);
  exception when others then
    raise exception 'INVALID_CONFIGURATION: valor inválido' using errcode = '22023';
  end;
  if v_amount is null or v_amount <= 0 or v_amount >= 100000000 then
    raise exception 'INVALID_CONFIGURATION: valor inválido' using errcode = '22023';
  end if;
  if v_competence !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or v_competence > v_today
     or v_competence < to_char((now() at time zone 'America/Fortaleza') - interval '12 months', 'YYYY-MM') then
    raise exception 'INVALID_CONFIGURATION: competência inválida (até 12 meses atrás, nunca no futuro)' using errcode = '22023';
  end if;

  -- clique duplo ou envio repetido: a mesma nota pedida há menos de 2 minutos não é emitida de novo
  if exists (
    select 1 from public.nfse_emissions e
     where e.client_id = v_client_id and e.test_env = v_test
       and e.status in ('queued', 'processing', 'issued')
       and e.amount = v_amount and e.description = v_description
       and coalesce(e.toma_doc, '') = coalesce(v_toma_doc, '')
       and e.created_at > now() - interval '2 minutes'
  ) then
    raise exception 'DUPLICATE_EMISSION: esta mesma nota já foi pedida há menos de 2 minutos' using errcode = '23505';
  end if;

  select b.start_date, b.end_date into v_start, v_end from public.competence_bounds(v_competence) b;

  insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                      operations, force_reschedule, status, current_step, last_message)
  values (v_client_id, v_uid, v_client.provider, v_competence, v_start, v_end,
          array['NFSE_EMIT']::public.task_type[], false, 'queued', 'queued', 'Aguardando o robô para emitir a NFS-e')
  returning id into v_job_id;

  insert into public.automation_tasks (job_id, client_id, task_type, status, competence, operation_type)
  values (v_job_id, v_client_id, 'NFSE_EMIT', 'pending', v_competence, 'NFSE');

  insert into public.nfse_emissions (client_id, created_by, test_env, source, request_text, model_chave, toma_chave, toma,
                                     toma_doc, toma_nome, c_trib_nac, c_trib_mun, servico_nome, description, amount,
                                     competence, status, job_id, last_message)
  values (v_client_id, v_uid, v_test, v_source, nullif(left(trim(coalesce(p->>'request_text', '')), 2000), ''),
          v_model.chave, v_toma_chave, v_toma, nullif(v_toma_doc, ''), nullif(v_toma_nome, ''),
          v_model.c_trib_nac, v_model.c_trib_mun, coalesce(v_model.servico_nome, nullif(p->>'servico_nome', '')),
          v_description, v_amount, v_competence, 'queued', v_job_id, 'Na fila do robô')
  returning id into v_id;

  perform public.write_audit_log('nfse.emit_requested', 'nfse_emission', v_id::text, v_client_id,
    jsonb_build_object('amount', v_amount, 'competence', v_competence, 'test_env', v_test, 'source', v_source, 'job_id', v_job_id));

  return jsonb_build_object('emission_id', v_id, 'job_id', v_job_id);
end;
$$;

revoke execute on function public.create_nfse_emission(jsonb) from public, anon;
grant execute on function public.create_nfse_emission(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- RPC do painel: pedir o cancelamento de uma nota emitida pelo sistema
-- ---------------------------------------------------------------------
create or replace function public.request_nfse_cancel(p_emission_id uuid, p_reason_code integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_em public.nfse_emissions;
  v_client public.clients;
  v_reason text := trim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
  v_start date;
  v_end date;
  v_job_id uuid;
begin
  if not (auth.role() = 'service_role' or public.can_operate()) then
    raise exception 'FORBIDDEN: usuário sem permissão para cancelar NFS-e' using errcode = '42501';
  end if;
  select * into v_em from public.nfse_emissions where id = p_emission_id for update;
  if not found then
    raise exception 'EMISSION_NOT_FOUND: nota não encontrada' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_em.org_id, 'EMISSION');
  if v_em.status <> 'issued' or v_em.chave is null then
    raise exception 'INVALID_STATE: só dá para cancelar uma nota emitida' using errcode = '22023';
  end if;
  if v_em.cancel_status in ('requested', 'processing') then
    raise exception 'INVALID_STATE: o cancelamento desta nota já foi pedido' using errcode = '22023';
  end if;
  -- motivos do leiaute nacional: 1 erro na emissão, 2 serviço não prestado, 9 outros
  if p_reason_code not in (1, 2, 9) then
    raise exception 'INVALID_CONFIGURATION: motivo do cancelamento inválido' using errcode = '22023';
  end if;
  if length(v_reason) not between 15 and 255 then
    raise exception 'INVALID_CONFIGURATION: explique o motivo do cancelamento (de 15 a 255 letras)' using errcode = '22023';
  end if;

  select * into v_client from public.clients where id = v_em.client_id;
  select b.start_date, b.end_date into v_start, v_end from public.competence_bounds(v_em.competence) b;

  insert into public.automation_jobs (client_id, created_by, provider, competence, start_date, end_date,
                                      operations, force_reschedule, status, current_step, last_message)
  values (v_em.client_id, auth.uid(), v_client.provider, v_em.competence, v_start, v_end,
          array['NFSE_CANCEL']::public.task_type[], false, 'queued', 'queued', 'Aguardando o robô para cancelar a NFS-e')
  returning id into v_job_id;

  insert into public.automation_tasks (job_id, client_id, task_type, status, competence, operation_type)
  values (v_job_id, v_em.client_id, 'NFSE_CANCEL', 'pending', v_em.competence, 'NFSE');

  update public.nfse_emissions
     set cancel_status = 'requested', cancel_job_id = v_job_id, cancel_reason_code = p_reason_code,
         cancel_reason = v_reason, cancel_requested_by = auth.uid(), cancel_requested_at = now(),
         cancel_errors = '[]'::jsonb
   where id = p_emission_id;

  perform public.write_audit_log('nfse.cancel_requested', 'nfse_emission', p_emission_id::text, v_em.client_id,
    jsonb_build_object('reason_code', p_reason_code, 'job_id', v_job_id));

  return jsonb_build_object('emission_id', p_emission_id, 'job_id', v_job_id);
end;
$$;

revoke execute on function public.request_nfse_cancel(uuid, integer, text) from public, anon;
grant execute on function public.request_nfse_cancel(uuid, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- RPCs do robô: começar a emissão (com o número da DPS) e pular um número já usado na prefeitura
-- ---------------------------------------------------------------------
create or replace function public.nfse_emission_begin(p_job_id uuid)
returns setof public.nfse_emissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_em public.nfse_emissions;
  v_n bigint;
begin
  select * into v_em from public.nfse_emissions where job_id = p_job_id limit 1 for update;
  if not found then
    return;
  end if;
  if not (auth.role() = 'service_role' or v_em.org_id = public.device_org_id()) then
    raise exception 'FORBIDDEN: trabalho de outro escritório' using errcode = '42501';
  end if;
  if v_em.status in ('issued', 'canceled') then
    return next v_em;  -- já emitida: o robô só confere e encerra
    return;
  end if;
  if v_em.n_dps is null then
    -- uma sequência por cliente e ambiente; a trava evita dois robôs com o mesmo número
    perform pg_advisory_xact_lock(hashtextextended(v_em.client_id::text || ':' || v_em.test_env::text, 0));
    select coalesce(max(e.n_dps), 0) + 1 into v_n from public.nfse_emissions e
     where e.client_id = v_em.client_id and e.test_env = v_em.test_env and e.serie = '10001';
    update public.nfse_emissions set serie = '10001', n_dps = v_n where id = v_em.id;
  end if;
  update public.nfse_emissions
     set status = 'processing', errors = '[]'::jsonb, last_message = 'O robô começou a emissão',
         steps = steps || jsonb_build_object('started_at', now())
   where id = v_em.id
  returning * into v_em;
  return next v_em;
end;
$$;

revoke execute on function public.nfse_emission_begin(uuid) from public, anon;
grant execute on function public.nfse_emission_begin(uuid) to authenticated, service_role;

create or replace function public.nfse_emission_bump_number(p_emission_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_em public.nfse_emissions;
  v_n bigint;
begin
  select * into v_em from public.nfse_emissions where id = p_emission_id for update;
  if not found then
    raise exception 'EMISSION_NOT_FOUND: nota não encontrada' using errcode = 'P0002';
  end if;
  if not (auth.role() = 'service_role' or v_em.org_id = public.device_org_id()) then
    raise exception 'FORBIDDEN: trabalho de outro escritório' using errcode = '42501';
  end if;
  -- só antes do envio: depois que a DPS saiu, o número é dela
  if v_em.status <> 'processing' or v_em.send_started_at is not null then
    raise exception 'INVALID_STATE: a DPS desta nota já foi enviada' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_em.client_id::text || ':' || v_em.test_env::text, 0));
  select coalesce(max(e.n_dps), 0) + 1 into v_n from public.nfse_emissions e
   where e.client_id = v_em.client_id and e.test_env = v_em.test_env and e.serie = '10001';
  update public.nfse_emissions set n_dps = v_n, id_dps = null where id = p_emission_id;
  return v_n;
end;
$$;

revoke execute on function public.nfse_emission_bump_number(uuid) from public, anon;
grant execute on function public.nfse_emission_bump_number(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- O trabalho terminou sem emitir ou sem cancelar (erro, cancelado na fila, certificado ausente): a
-- linha da nota acompanha, para o painel nunca mostrar uma emissão "em andamento" que já parou
-- ---------------------------------------------------------------------
create or replace function public.nfse_emissions_follow_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is not distinct from old.status
     or new.status not in ('failed', 'cancelled', 'certificate_required') then
    return new;
  end if;
  if 'NFSE_EMIT' = any(new.operations) then
    update public.nfse_emissions
       set status = 'failed',
           last_message = coalesce(new.error_message, new.last_message, 'A emissão não foi concluída')
     where job_id = new.id and status in ('queued', 'processing');
  elsif 'NFSE_CANCEL' = any(new.operations) then
    update public.nfse_emissions
       set cancel_status = 'rejected',
           cancel_errors = jsonb_build_array(jsonb_build_object(
             'codigo', coalesce(new.error_code, ''),
             'mensagem', coalesce(new.error_message, new.last_message, 'O cancelamento não foi concluído')))
     where cancel_job_id = new.id and status = 'issued' and cancel_status in ('requested', 'processing');
  end if;
  return new;
end;
$$;

drop trigger if exists nfse_emissions_follow_job on public.automation_jobs;
create trigger nfse_emissions_follow_job
after update of status on public.automation_jobs
for each row execute function public.nfse_emissions_follow_job();

-- ---------------------------------------------------------------------
-- Empresa só de serviço (sem SIAT) também emite e cancela NFS-e
-- ---------------------------------------------------------------------
create or replace function public.automation_jobs_require_siat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from unnest(new.operations) op where op::text not in ('NFSE_FETCH', 'NFSE_EMIT', 'NFSE_CANCEL'))
     and exists (select 1 from public.clients c where c.id = new.client_id and not c.uses_siat) then
    raise exception 'NO_SIAT: empresa sem inscrição estadual não usa o SIAT (só a NFS-e Nacional)' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Fila: emissão e cancelamento só para robôs 1.2.37+; passam na frente (alguém está esperando na
-- tela) e não esperam outro trabalho do mesmo cliente (não usam o navegador)
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
  v_host text := public.worker_host(p_worker_id);
  v_efd boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 0]);
  v_malha boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 19]);
  v_key boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 34]);
  v_nfse boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 36]);
  v_emit boolean := public.worker_version_at_least(p_worker_id, array[1, 2, 37]);
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
     and (v_efd or not ('EFD_CHECK' = any(j.operations)))
     and (v_malha or not ('MALHA_CHECK' = any(j.operations)))
     and (v_key or not ('NFE_KEY_EXPORT' = any(j.operations)))
     and (v_nfse or not ('NFSE_FETCH' = any(j.operations)))
     and (v_emit or not (j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]))
     -- este computador já disse que não tem o certificado do cliente
     and not (v_host = any(j.skip_hosts))
     -- nunca usar o mesmo perfil de navegador (cliente) em paralelo
     and (
       j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]
       or not exists (
         select 1 from public.automation_jobs other
          where other.client_id = j.client_id
            and other.id <> j.id
            and other.locked_by is not null
       )
     )
   order by (j.operations && array['NFSE_EMIT', 'NFSE_CANCEL']::public.task_type[]) desc, j.next_attempt_at, j.created_at
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

-- ---------------------------------------------------------------------
-- Reprocessar: também refaz a emissão e o cancelamento que falharam (o robô confere na prefeitura,
-- pelo número da DPS, se a nota já saiu antes de enviar de novo)
-- ---------------------------------------------------------------------
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
                         'NFE_ISSUED_CANCELED_EXPORT', 'NFE_RECEIVED_CANCELED_EXPORT', 'NFE_KEY_EXPORT',
                         'EFD_CHECK', 'MALHA_CHECK', 'NFSE_FETCH', 'NFSE_EMIT', 'NFSE_CANCEL')
       and (status in ('failed', 'cancelled', 'running', 'dry_run')
            -- nota pela chave: o SIAT não agenda (entrega o arquivo no clique); um pedido que ficou
            -- "agendado" sem ID não existe no portal e precisa ser refeito do zero
            or (task_type = 'NFE_KEY_EXPORT' and status in ('scheduled', 'processed') and external_request_id is null))
  loop
    begin
      update public.automation_tasks
         set status = 'pending', error_message = null, retry_count = retry_count + 1,
             started_at = null, finished_at = null, requested_at = null
       where id = r.id;
    exception when unique_violation then
      update public.automation_tasks
         set status = 'skipped', error_message = 'Exportação já agendada por outro job.'
       where id = r.id;
    end;
  end loop;

  -- emissão/cancelamento de NFS-e: a linha da nota volta a esperar o robô
  update public.nfse_emissions
     set status = 'queued', errors = '[]'::jsonb, last_message = 'Reprocessamento solicitado'
   where job_id = p_job_id and status in ('failed', 'rejected');
  update public.nfse_emissions
     set cancel_status = 'requested', cancel_errors = '[]'::jsonb
   where cancel_job_id = p_job_id and status = 'issued' and cancel_status = 'rejected';

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

-- ---------------------------------------------------------------------
-- Avisos: emissão e cancelamento levam para a tela Emitir NFS-e
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
  v_emit boolean := 'NFSE_EMIT' = any(new.operations);
  v_cancel boolean := 'NFSE_CANCEL' = any(new.operations);
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
  elsif new.status = 'completed' and v_emit then
    perform public.notify_operators(
      new.created_by, 'success', 'NFS-e emitida.',
      format('%s: %s', v_client, coalesce(new.last_message, 'nota emitida.')),
      '/emissao', 'job-completed:' || new.id, new.org_id);
  elsif new.status = 'completed' and v_cancel then
    perform public.notify_operators(
      new.created_by, 'success', 'NFS-e cancelada.',
      format('%s: %s', v_client, coalesce(new.last_message, 'nota cancelada.')),
      '/emissao', 'job-completed:' || new.id, new.org_id);
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
  elsif new.status = 'failed' and v_emit then
    perform public.notify_operators(
      new.created_by, 'error', 'NFS-e não emitida.',
      format('%s: %s', v_client, coalesce(new.error_message, new.error_code, 'Falha na emissão.')),
      '/emissao', 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
  elsif new.status = 'failed' and v_cancel then
    perform public.notify_operators(
      new.created_by, 'error', 'Cancelamento de NFS-e não concluído.',
      format('%s: %s', v_client, coalesce(new.error_message, new.error_code, 'Falha no cancelamento.')),
      '/emissao', 'job-failed:' || new.id || ':' || new.attempts, new.org_id);
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
