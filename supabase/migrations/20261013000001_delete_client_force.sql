-- Excluir cliente que já tem histórico (administrador, confirmado na tela): apaga o cadastro e tudo que
-- está ligado a ele no banco (trabalhos, registros de download, índice de notas, EFD, malhas, NFS-e e o
-- certificado do painel). Os arquivos na pasta de notas e o .pfx instalado nos computadores não são tocados.
-- Sem p_force, continua como antes: cliente com histórico não sai (HAS_HISTORY).

drop function if exists public.delete_client(uuid);

create or replace function public.delete_client(p_client_id uuid, p_force boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_jobs int;
  v_downloads int;
  v_efd int;
  v_notes int;
  v_malhas int;
  v_certs int;
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'FORBIDDEN: somente administradores podem excluir clientes' using errcode = '42501';
  end if;

  select * into v_client from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'CLIENT_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;
  perform public.assert_same_org(v_client.org_id, 'CLIENT');

  select count(*) into v_jobs from public.automation_jobs where client_id = p_client_id;
  select count(*) into v_downloads from public.downloads where client_id = p_client_id;
  select count(*) into v_efd from public.efd_declarations where client_id = p_client_id;
  select count(*) into v_notes from public.notes where client_id = p_client_id;
  select count(*) into v_malhas from public.malha_checks where client_id = p_client_id;
  select count(*) into v_certs from public.certificates where client_id = p_client_id;

  if v_jobs + v_downloads + v_efd > 0 and not coalesce(p_force, false) then
    raise exception 'HAS_HISTORY: o cliente tem % agendamento(s), % nota(s) baixada(s) e % EFD(s) registrada(s)',
      v_jobs, v_downloads, v_efd using errcode = '23503';
  end if;

  -- o que foi apagado junto fica na auditoria (o cadastro em si a auditoria automática registra em client.deleted)
  if v_jobs + v_downloads + v_efd + v_notes + v_malhas > 0 then
    insert into public.audit_logs (user_id, action, entity, entity_id, data)
    values (
      auth.uid(), 'client.history_deleted', 'client', p_client_id::text,
      jsonb_build_object(
        'client_code', v_client.client_code, 'legal_name', v_client.legal_name, 'cnpj', v_client.cnpj,
        'jobs', v_jobs, 'downloads', v_downloads, 'notes', v_notes, 'efd', v_efd, 'malhas', v_malhas, 'certificates', v_certs
      )
    );
  end if;

  -- certificados primeiro (só o cadastro no painel; o .pfx instalado no Windows não é tocado):
  -- em cascata, a auditoria do certificado apontaria para um cliente que já sumiu
  delete from public.certificates where client_id = p_client_id;
  -- o resto (trabalhos e seus registros, downloads, notas, EFD, malhas, NFS-e) sai em cascata;
  -- a auditoria automática (clients_audit) grava "client.deleted" com os dados do cliente
  delete from public.clients where id = p_client_id;
end;
$$;

revoke execute on function public.delete_client(uuid, boolean) from public, anon;
grant execute on function public.delete_client(uuid, boolean) to authenticated, service_role;
