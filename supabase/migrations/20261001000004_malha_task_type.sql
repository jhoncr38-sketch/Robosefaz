-- Consulta de Malhas Fiscais (SIAT web: Autoatendimento -> Malhas Fiscais -> Consulta de Malhas).
-- O valor novo do enum fica numa migration própria: o Postgres não permite usar
-- um valor recém-criado na mesma transação (a próxima migration usa 'MALHA_CHECK').
alter type public.task_type add value if not exists 'MALHA_CHECK';
