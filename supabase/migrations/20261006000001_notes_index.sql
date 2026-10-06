-- Índice das notas (XMLs) dentro dos ZIPs baixados e o XML sob demanda ("ver a nota").
--
-- O robô lê cada XML ao contar as notas (manutenção, só leitura) e grava aqui os dados principais:
-- chave, número, série, data, valor, emitente e destinatário. O painel busca por número, chave ou
-- CNPJ e, para mostrar a nota, pede o XML (request_note_xml): o robô que tem a pasta das notas
-- extrai só aquele XML do ZIP e grava em notes.xml. Guardar todos os XMLs ficaria pesado (30 MB/mês).
--
-- A limpeza automática apaga o registro do download depois de 60 dias (o ZIP fica no Drive); o
-- índice fica: download_id vira null e zip_path diz onde o ZIP está.

alter table public.downloads add column if not exists notes_indexed_at timestamptz;
create index if not exists downloads_notes_pending_idx
  on public.downloads (downloaded_at desc) where notes_indexed_at is null;

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  client_id uuid not null references public.clients(id) on delete cascade,
  download_id uuid references public.downloads(id) on delete set null,
  document_type public.document_type not null,
  competence text not null,
  chave char(44) not null,
  modelo smallint,
  serie integer,
  numero bigint,
  emitida_em timestamptz,
  valor numeric(15, 2),
  emit_doc text,
  emit_nome text,
  emit_uf text,
  dest_doc text,
  dest_nome text,
  dest_uf text,
  cstat text,
  -- veio do ZIP de canceladas (o XML é o da nota autorizada)
  canceled boolean not null default false,
  zip_path text not null,
  xml_name text not null,
  xml text,
  xml_requested_at timestamptz,
  xml_at timestamptz,
  xml_error text,
  created_at timestamptz not null default now(),
  constraint notes_chave_format check (chave ~ '^[0-9]{44}$')
);

-- a mesma nota pode estar em dois ZIPs do mesmo mês (reagendamento) e em dois clientes
-- (emitente e destinatário): uma linha por cliente, tipo e chave
create unique index if not exists notes_unique_client_doc_chave on public.notes (client_id, document_type, chave);
create index if not exists notes_org_chave_idx on public.notes (org_id, chave);
create index if not exists notes_org_numero_idx on public.notes (org_id, numero);
create index if not exists notes_org_dest_idx on public.notes (org_id, dest_doc);
create index if not exists notes_org_emit_idx on public.notes (org_id, emit_doc);
create index if not exists notes_client_emitida_idx on public.notes (client_id, emitida_em desc);
-- o robô procura só os XMLs pedidos e ainda não entregues
create index if not exists notes_xml_pending_idx on public.notes (xml_requested_at)
  where xml_requested_at is not null and xml is null and xml_error is null;

drop trigger if exists notes_set_org on public.notes;
create trigger notes_set_org
before insert or update of client_id on public.notes
for each row execute function public.set_org_from_client();

alter table public.notes enable row level security;

drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes
  for select to authenticated using (org_id = public.current_org_id() and public.is_active_user());

drop policy if exists device_notes_select on public.notes;
create policy device_notes_select on public.notes
  for select to authenticated using (org_id = public.device_org_id());
drop policy if exists device_notes_insert on public.notes;
create policy device_notes_insert on public.notes
  for insert to authenticated with check (org_id = public.device_org_id());
drop policy if exists device_notes_update on public.notes;
create policy device_notes_update on public.notes
  for update to authenticated
  using (org_id = public.device_org_id()) with check (org_id = public.device_org_id());
drop policy if exists device_notes_delete on public.notes;
create policy device_notes_delete on public.notes
  for delete to authenticated using (org_id = public.device_org_id());

-- o painel acompanha a chegada do XML em tempo real
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notes;
  end if;
end $$;

-- "Ver a nota": o usuário pede o XML; o robô do escritório entrega.
create or replace function public.request_note_xml(p_note_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'FORBIDDEN: usuário inativo' using errcode = '42501';
  end if;
  update public.notes
     set xml_requested_at = now(), xml_error = null
   where id = p_note_id
     and org_id = public.current_org_id()
     and xml is null;
  return found;
end;
$$;
grant execute on function public.request_note_xml(uuid) to authenticated;
