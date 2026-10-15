-- Resultados › Faturamento, visão "Todas as empresas": resumo por empresa e mês, mantido por gatilho.
--
-- Somar na hora, empresa por empresa (faturamento_mensal), levou 24 s para 47 empresas em 14/10/2026
-- (a maior sozinha, 7,6 s). Este resumo guarda as seis somas prontas, uma linha por empresa e mês, e o
-- banco a refaz sozinho sempre que o robô grava, altera ou apaga notas no índice (gatilhos por comando,
-- com as tabelas de transição: cada par empresa+mês tocado é recalculado uma vez por comando).
-- O painel lê só este resumo, tanto para "Todas as empresas" quanto para uma empresa só.
-- Mesma conta de faturamento_mensal: saídas = NF-e emitidas + NFC-e; entradas = NF-e recebidas;
-- prestados/tomados = NFS-e; canceladas ficam fora da soma e são contadas.

create table if not exists public.faturamento_resumo (
  org_id uuid,
  client_id uuid not null references public.clients(id) on delete cascade,
  competence text not null,
  saidas numeric(15, 2) not null default 0,
  entradas numeric(15, 2) not null default 0,
  prestados numeric(15, 2) not null default 0,
  tomados numeric(15, 2) not null default 0,
  notas integer not null default 0,
  canceladas integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (client_id, competence)
);
create index if not exists faturamento_resumo_org_comp_idx on public.faturamento_resumo (org_id, competence);
-- o recálculo lê só as notas da empresa naquele mês
create index if not exists notes_client_competence_idx on public.notes (client_id, competence);

alter table public.faturamento_resumo enable row level security;
drop policy if exists faturamento_resumo_select on public.faturamento_resumo;
create policy faturamento_resumo_select on public.faturamento_resumo
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());
-- sem política de escrita: só os gatilhos (security definer) gravam

-- Refaz a linha de uma empresa em um mês a partir das notas; sem notas, a linha some.
create or replace function public.faturamento_recalcular(p_client_id uuid, p_competence text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
begin
  if p_client_id is null or p_competence !~ '^\d{4}-\d{2}$' then
    return;
  end if;
  with m as (
    select
      coalesce(n.valor, 0) as valor,
      (n.canceled or n.document_type::text like '%\_CANCELADAS') as cancelada,
      case replace(n.document_type::text, '_CANCELADAS', '')
        when 'NFE_EMITIDAS' then 'saidas'
        when 'NFCE' then 'saidas'
        when 'NFE_RECEBIDAS' then 'entradas'
        when 'NFSE_PRESTADAS' then 'prestados'
        when 'NFSE_TOMADAS' then 'tomados'
      end as grupo
    from public.notes n
    where n.client_id = p_client_id and n.competence = p_competence
  )
  select
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'saidas'), 0) as saidas,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'entradas'), 0) as entradas,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'prestados'), 0) as prestados,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'tomados'), 0) as tomados,
    (count(*) filter (where not m.cancelada))::int as notas,
    (count(*) filter (where m.cancelada))::int as canceladas
  into s
  from m
  where m.grupo is not null;

  if s.notas = 0 and s.canceladas = 0 then
    delete from public.faturamento_resumo where client_id = p_client_id and competence = p_competence;
    return;
  end if;

  insert into public.faturamento_resumo
    (org_id, client_id, competence, saidas, entradas, prestados, tomados, notas, canceladas, updated_at)
  select c.org_id, p_client_id, p_competence, s.saidas, s.entradas, s.prestados, s.tomados, s.notas, s.canceladas, now()
  from public.clients c
  where c.id = p_client_id
  on conflict (client_id, competence) do update set
    org_id = excluded.org_id,
    saidas = excluded.saidas,
    entradas = excluded.entradas,
    prestados = excluded.prestados,
    tomados = excluded.tomados,
    notas = excluded.notas,
    canceladas = excluded.canceladas,
    updated_at = now();
end;
$$;
revoke execute on function public.faturamento_recalcular(uuid, text) from public, anon, authenticated;

-- Gatilhos por comando: um por operação, cada um lendo só a sua tabela de transição.
create or replace function public.faturamento_resumo_apos_inserir()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in select distinct client_id, competence from novas loop
    perform public.faturamento_recalcular(r.client_id, r.competence);
  end loop;
  return null;
end;
$$;

create or replace function public.faturamento_resumo_apos_alterar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  -- só quando mudou algo que entra na conta (a chegada do XML, por exemplo, não recalcula nada);
  -- o Postgres não aceita tabela de transição em gatilho "update of colunas", então o filtro é aqui
  for r in
    select n.client_id, n.competence
      from novas n join antigas a on a.id = n.id
     where (a.client_id, a.competence, a.document_type, a.valor, a.canceled)
           is distinct from (n.client_id, n.competence, n.document_type, n.valor, n.canceled)
    union
    select a.client_id, a.competence
      from antigas a join novas n on a.id = n.id
     where (a.client_id, a.competence) is distinct from (n.client_id, n.competence)
  loop
    perform public.faturamento_recalcular(r.client_id, r.competence);
  end loop;
  return null;
end;
$$;

create or replace function public.faturamento_resumo_apos_apagar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  for r in select distinct client_id, competence from antigas loop
    perform public.faturamento_recalcular(r.client_id, r.competence);
  end loop;
  return null;
end;
$$;

drop trigger if exists faturamento_resumo_ins on public.notes;
create trigger faturamento_resumo_ins
  after insert on public.notes
  referencing new table as novas
  for each statement execute function public.faturamento_resumo_apos_inserir();

drop trigger if exists faturamento_resumo_upd on public.notes;
create trigger faturamento_resumo_upd
  after update on public.notes
  referencing old table as antigas new table as novas
  for each statement execute function public.faturamento_resumo_apos_alterar();

drop trigger if exists faturamento_resumo_del on public.notes;
create trigger faturamento_resumo_del
  after delete on public.notes
  referencing old table as antigas
  for each statement execute function public.faturamento_resumo_apos_apagar();

-- carga inicial: tudo o que já está no índice
select public.faturamento_recalcular(p.client_id, p.competence)
from (select distinct client_id, competence from public.notes) p;
