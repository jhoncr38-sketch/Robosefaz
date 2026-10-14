-- Tela Resultados › Faturamento: somas do índice de notas de uma empresa por mês de competência.
-- Saídas = NF-e emitidas + NFC-e; entradas = NF-e recebidas; serviços prestados e tomados = NFS-e.
-- Notas canceladas (marcadas no índice ou vindas do arquivo de canceladas) ficam fora da soma e são contadas.
-- Só leitura, com o RLS do próprio usuário (security invoker): cada escritório vê só as suas empresas.
-- Sem CFOP, as saídas incluem remessas, devoluções e transferências (a separação por CFOP é uma etapa futura).

create or replace function public.faturamento_mensal(p_client_id uuid)
returns table (
  competence text,
  saidas numeric,
  entradas numeric,
  prestados numeric,
  tomados numeric,
  notas integer,
  canceladas integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with m as (
    select
      coalesce(n.competence, to_char(n.emitida_em at time zone 'America/Sao_Paulo', 'YYYY-MM')) as competence,
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
    where n.client_id = p_client_id
  )
  select
    m.competence,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'saidas'), 0) as saidas,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'entradas'), 0) as entradas,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'prestados'), 0) as prestados,
    coalesce(sum(m.valor) filter (where not m.cancelada and m.grupo = 'tomados'), 0) as tomados,
    (count(*) filter (where not m.cancelada))::int as notas,
    (count(*) filter (where m.cancelada))::int as canceladas
  from m
  where m.competence ~ '^\d{4}-\d{2}$' and m.grupo is not null
  group by m.competence
  order by m.competence desc;
$$;

revoke execute on function public.faturamento_mensal(uuid) from public, anon;
grant execute on function public.faturamento_mensal(uuid) to authenticated, service_role;
