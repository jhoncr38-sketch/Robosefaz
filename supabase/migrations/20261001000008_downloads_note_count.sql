-- Quantidade de notas (XMLs) dentro de cada ZIP baixado.
-- O robô conta na manutenção, fora do download, aos poucos (política device_downloads_update);
-- o painel mostra "2.308 notas" e avisa quando um mês fica sem notas ou cai bruscamente
-- em relação aos meses anteriores do mesmo cliente e tipo. null = ainda não contado.
alter table public.downloads add column if not exists note_count integer;

alter table public.downloads drop constraint if exists downloads_note_count_check;
alter table public.downloads add constraint downloads_note_count_check
  check (note_count is null or note_count >= 0);

-- o robô procura só as que faltam contar
create index if not exists downloads_note_count_pending_idx
  on public.downloads (downloaded_at desc) where note_count is null;
