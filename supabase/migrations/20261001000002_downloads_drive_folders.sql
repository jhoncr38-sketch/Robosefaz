-- Pastas das notas no Google Drive (ano/mês e ano/mês/cliente), gravadas pelo
-- robô junto com o código do arquivo. O painel usa para "Baixar todas as notas
-- de 09/2026" e "Baixar notas da LIA 08/2026": abre a pasta no Drive, que a
-- baixa inteira como ZIP.
alter table public.downloads add column if not exists drive_client_folder_id text;
alter table public.downloads add column if not exists drive_month_folder_id text;

alter table public.downloads drop constraint if exists downloads_drive_folders_format;
alter table public.downloads add constraint downloads_drive_folders_format check (
  (drive_client_folder_id is null or drive_client_folder_id ~ '^[A-Za-z0-9_-]{15,100}$')
  and (drive_month_folder_id is null or drive_month_folder_id ~ '^[A-Za-z0-9_-]{15,100}$')
);
