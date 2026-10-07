-- Nota pela chave (robô 1.2.34): a pessoa digita a chave de acesso na tela Notas, escolhe a
-- empresa e o robô entra no SIAT com o certificado dela e exporta só aquela nota
-- ("Pesquisar SOMENTE pela Chave da NFE" -> Exportar). O valor novo fica num arquivo só dele:
-- o Postgres não deixa usar um valor de enum na mesma transação em que ele foi criado.
alter type public.task_type add value if not exists 'NFE_KEY_EXPORT';
