-- Escritório do computador ativado (código e nome), para o robô marcar a pasta das notas como
-- sendo deste escritório. Dois escritórios na mesma conta do Google não podem dividir a mesma
-- pasta: os códigos de cliente se repetem entre escritórios (CLI000001...) e o robô de um
-- renomearia ou ligaria as notas do outro. O computador só enxerga o próprio escritório.
create or replace function public.device_org()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.name from public.organizations o where o.id = public.device_org_id();
$$;

revoke execute on function public.device_org() from public, anon;
grant execute on function public.device_org() to authenticated, service_role;
