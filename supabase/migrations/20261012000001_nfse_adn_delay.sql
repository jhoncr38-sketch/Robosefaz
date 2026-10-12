-- NFS-e: quanto a prefeitura demora para repassar a nota ao ambiente nacional (ADN).
--
-- A busca de NFS-e recebe, junto com cada nota, a hora em que o ambiente nacional a gerou na distribuição.
-- Comparada com a hora da autorização (dhProc do XML), dá o atraso do repasse. O painel usa isso para avisar,
-- na tela NFS-e Nacional, quando uma prefeitura está demorando e uma nota recente pode ainda não ter chegado.
--
-- Só notas de serviço: nas notas do SIAT (NF-e, NFC-e) as três colunas ficam vazias e nada muda.

alter table public.notes
  add column if not exists adn_recebida_em timestamptz,
  add column if not exists adn_atraso_s integer,
  add column if not exists amb_ger smallint;

comment on column public.notes.adn_recebida_em is 'NFS-e: quando o ambiente nacional (ADN) gerou a nota na distribuição';
comment on column public.notes.adn_atraso_s is 'NFS-e: segundos entre a autorização na origem (dhProc) e a chegada ao ADN';
comment on column public.notes.amb_ger is 'NFS-e: quem gerou a nota (1 = sistema da prefeitura, 2 = emissor nacional)';

create index if not exists notes_adn_recebida_idx on public.notes (org_id, adn_recebida_em) where adn_recebida_em is not null;

-- O robô grava a chegada das notas de uma busca. Vale a primeira vez em que a nota é vista: reler o mesmo
-- documento depois não muda a hora já gravada. Roda com as permissões de quem chama, então o robô só alcança as
-- notas do próprio escritório (política device_notes_update).
create or replace function public.nfse_set_arrivals(p_client_id uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item jsonb;
  v_rows integer;
  v_count integer := 0;
begin
  -- uma nota por vez, pela chave: cada atualização usa o índice (cliente, tipo, chave), e a chamada continua
  -- rápida mesmo em empresa com dezenas de milhares de notas
  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    continue when coalesce(v_item->>'chave', '') = '' or coalesce(v_item->>'recebida_em', '') = '' or coalesce(v_item->>'atraso_s', '') = '';
    update public.notes n
       set adn_recebida_em = (v_item->>'recebida_em')::timestamptz,
           adn_atraso_s = greatest(0, (v_item->>'atraso_s')::integer),
           amb_ger = nullif(v_item->>'amb_ger', '')::smallint,
           c_loc_emi = coalesce(n.c_loc_emi, nullif(v_item->>'c_loc_emi', ''))
     where n.client_id = p_client_id
       and n.document_type in ('NFSE_PRESTADAS', 'NFSE_TOMADAS')
       and n.chave = v_item->>'chave'
       and n.adn_recebida_em is null;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.nfse_set_arrivals(uuid, jsonb) from public, anon;
grant execute on function public.nfse_set_arrivals(uuid, jsonb) to authenticated, service_role;

-- Painel: atraso do repasse por cidade emissora, nas notas do escritório que chegaram ao ambiente nacional nos
-- últimos p_days dias. Conta só as notas geradas pelo sistema da prefeitura (as do emissor nacional já nascem lá).
create or replace function public.nfse_adn_delay(p_days integer default 30)
returns table (c_loc_emi text, notas bigint, mediana_s integer, acima_1d bigint, pior_s integer, ultima_chegada timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.c_loc_emi,
         count(*),
         (percentile_cont(0.5) within group (order by n.adn_atraso_s))::integer,
         count(*) filter (where n.adn_atraso_s > 86400),
         max(n.adn_atraso_s),
         max(n.adn_recebida_em)
    from public.notes n
   where n.org_id = public.current_org_id()
     and public.is_active_user()
     and n.document_type in ('NFSE_PRESTADAS', 'NFSE_TOMADAS')
     and n.amb_ger = 1
     and n.c_loc_emi is not null
     and n.adn_atraso_s is not null
     and n.adn_recebida_em >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
   group by n.c_loc_emi
   order by count(*) desc;
$$;
revoke execute on function public.nfse_adn_delay(integer) from public, anon;
grant execute on function public.nfse_adn_delay(integer) to authenticated, service_role;
