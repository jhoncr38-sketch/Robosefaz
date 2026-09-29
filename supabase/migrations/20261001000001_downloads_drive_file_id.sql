-- Código do arquivo no Google Drive (notas salvas na pasta do Drive).
-- O robô lê o código no Google Drive para computador depois que a nota sobe e
-- grava aqui (política device_downloads_update); o painel usa para o botão
-- "Baixar", que baixa direto do Drive em qualquer computador.
alter table public.downloads add column if not exists drive_file_id text;

alter table public.downloads drop constraint if exists downloads_drive_file_id_format;
-- só o formato de ID do Drive: o painel monta o link com ele
alter table public.downloads add constraint downloads_drive_file_id_format
  check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{20,100}$');
