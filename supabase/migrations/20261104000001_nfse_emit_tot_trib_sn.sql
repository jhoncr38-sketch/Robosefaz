-- Emissão de NFS-e pelo ambiente nacional (robô 1.2.44): percentual aproximado dos tributos.
-- Desde 01/11/2026 a ME/EPP do Simples emite pelo Sefin Nacional (Resolução CGSN nº 191). Para ME/EPP ele
-- recusa o "não informar o total de tributos" (indTotTrib) que as notas da prefeitura traziam (E0712) e
-- exige o percentual aproximado da alíquota do Simples Nacional (pTotTribSN, Lei 12.741/2012), como as notas
-- do Emissor Nacional. O percentual é da empresa e muda com o faturamento: a pessoa confere na tela.
-- - nfse_emissions.p_tot_trib_sn: o percentual conferido (o robô 1.2.44+ põe na nota);
-- - create_nfse_emission: passa a exigir o percentual (0 a 99,99).

alter table public.nfse_emissions
  add column if not exists p_tot_trib_sn numeric(5, 2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nfse_emissions_p_tot_trib_sn_check') then
    alter table public.nfse_emissions
      add constraint nfse_emissions_p_tot_trib_sn_check check (p_tot_trib_sn is null or (p_tot_trib_sn >= 0 and p_tot_trib_sn < 100));
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- RPC do painel: pedir a emissão (agora também com o percentual aproximado dos tributos)
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
  v_custom boolean := coalesce((p->>'custom_service')::boolean, false);
  v_nac text;
  v_mun text;
  v_nome text;
  v_nbs text;
  v_cst text;
  v_class text;
  v_indop text;
  v_tot numeric(5, 2);
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

  -- atividade: a da nota-modelo ou outra do cadastro da empresa, informada à mão (a prefeitura recusa
  -- o código que não estiver no cadastro); obra e ISS retido vêm da nota-modelo e não combinam com troca
  v_nac := v_model.c_trib_nac;
  v_mun := v_model.c_trib_mun;
  v_nome := coalesce(v_model.servico_nome, nullif(p->>'servico_nome', ''));
  if v_custom then
    v_nac := regexp_replace(coalesce(p->>'c_trib_nac', ''), '[^0-9]', '', 'g');
    v_mun := regexp_replace(coalesce(p->>'c_trib_mun', ''), '[^0-9]', '', 'g');
    if v_nac !~ '^[0-9]{6}$' or v_mun !~ '^[0-9]{3}$' then
      raise exception 'INVALID_CONFIGURATION: informe o código nacional (6 números) e o municipal (3 números) da atividade' using errcode = '22023';
    end if;
    if v_model.emit_model <> 'ok' then
      raise exception 'INVALID_CONFIGURATION: para informar outra atividade, a nota-modelo precisa valer para qualquer tomador (sem obra nem ISS retido)' using errcode = '22023';
    end if;
    v_nome := coalesce(nullif(trim(coalesce(p->>'servico_nome', '')), ''), 'Atividade informada à mão');
  end if;
  -- NBS e IBS/CBS como conferidos na tela: ausente = como na nota-modelo; vazio = a nota vai sem
  if p ? 'c_nbs' then
    v_nbs := regexp_replace(coalesce(p->>'c_nbs', ''), '[^0-9]', '', 'g');
    if v_nbs <> '' and v_nbs !~ '^[0-9]{9}$' then
      raise exception 'INVALID_CONFIGURATION: o código NBS tem 9 números' using errcode = '22023';
    end if;
  end if;
  if jsonb_typeof(p->'ibs') = 'object' then
    v_cst := regexp_replace(coalesce(p->'ibs'->>'cst', ''), '[^0-9]', '', 'g');
    v_class := regexp_replace(coalesce(p->'ibs'->>'class_trib', ''), '[^0-9]', '', 'g');
    v_indop := regexp_replace(coalesce(p->'ibs'->>'ind_op', ''), '[^0-9]', '', 'g');
    if (v_cst || v_class || v_indop) <> ''
       and (v_cst !~ '^[0-9]{3}$' or v_class !~ '^[0-9]{6}$' or v_indop !~ '^[0-9]{6}$') then
      raise exception 'INVALID_CONFIGURATION: para o IBS/CBS informe o CST (3 números), o cClassTrib (6) e o indicador da operação (6), ou deixe os três vazios' using errcode = '22023';
    end if;
  end if;

  -- percentual aproximado dos tributos (alíquota do Simples Nacional, Lei 12.741/2012), conferido na tela:
  -- para ME/EPP o ambiente nacional não aceita a nota sem ele (E0712)
  begin
    v_tot := round(nullif(trim(coalesce(p->>'p_tot_trib_sn', '')), '')::numeric, 2);
  exception when others then
    raise exception 'INVALID_CONFIGURATION: percentual aproximado dos tributos inválido' using errcode = '22023';
  end;
  if v_tot is null or v_tot < 0 or v_tot >= 100 then
    raise exception 'INVALID_CONFIGURATION: informe o percentual aproximado dos tributos (alíquota do Simples Nacional, de 0 a 99,99%%)' using errcode = '22023';
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
                                     competence, status, job_id, last_message,
                                     custom_service, c_nbs, ibs_cst, ibs_class_trib, ibs_ind_op, p_tot_trib_sn)
  values (v_client_id, v_uid, v_test, v_source, nullif(left(trim(coalesce(p->>'request_text', '')), 2000), ''),
          v_model.chave, v_toma_chave, v_toma, nullif(v_toma_doc, ''), nullif(v_toma_nome, ''),
          v_nac, v_mun, v_nome,
          v_description, v_amount, v_competence, 'queued', v_job_id, 'Na fila do robô',
          v_custom, v_nbs, v_cst, v_class, v_indop, v_tot)
  returning id into v_id;

  perform public.write_audit_log('nfse.emit_requested', 'nfse_emission', v_id::text, v_client_id,
    jsonb_build_object('amount', v_amount, 'competence', v_competence, 'test_env', v_test, 'source', v_source, 'job_id', v_job_id,
                       'p_tot_trib_sn', v_tot));

  return jsonb_build_object('emission_id', v_id, 'job_id', v_job_id);
end;
$$;

revoke execute on function public.create_nfse_emission(jsonb) from public, anon;
grant execute on function public.create_nfse_emission(jsonb) to authenticated, service_role;
