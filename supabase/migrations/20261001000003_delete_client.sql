-- Excluir cliente cadastrado por engano.
--
-- Só o administrador do escritório, e só cliente SEM histórico (nenhum
-- agendamento, nota baixada ou EFD lida): apagar um cliente com histórico
-- levaria junto agendamentos e registros de notas. Para esses, o painel
-- oferece "Desativar" (sai das automações, o histórico fica).
-- A exclusão fica na auditoria (client.deleted, com código, nome e CNPJ).
create or replace function public.delete_client(p_client_id uuid)
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
  if v_jobs + v_downloads + v_efd > 0 then
    raise exception 'HAS_HISTORY: o cliente tem % agendamento(s), % nota(s) baixada(s) e % EFD(s) registrada(s)',
      v_jobs, v_downloads, v_efd using errcode = '23503';
  end if;

  -- certificados primeiro (só o cadastro no painel; o .pfx instalado no Windows não é tocado):
  -- em cascata, a auditoria do certificado apontaria para um cliente que já sumiu
  delete from public.certificates where client_id = p_client_id;
  -- a auditoria automática (clients_audit) grava "client.deleted" com os dados do cliente
  delete from public.clients where id = p_client_id;
end;
$$;

revoke execute on function public.delete_client(uuid) from public, anon;
grant execute on function public.delete_client(uuid) to authenticated, service_role;
