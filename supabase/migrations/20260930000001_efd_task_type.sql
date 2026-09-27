-- Consulta do processamento da EFD (mensagens "EPE - EFD" do DT-e do SIAT).
-- O valor novo do enum fica numa migration própria: o Postgres não permite usar
-- um valor recém-criado na mesma transação (a próxima migration usa 'EFD_CHECK').
alter type public.task_type add value if not exists 'EFD_CHECK';
