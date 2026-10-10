-- NFS-e Nacional (robô 1.2.36): o robô busca na API do Ambiente de Dados Nacional (ADN) as notas de
-- serviço em que o cliente é prestador ou tomador, com o certificado dele, e grava um ZIP por mês.
-- Os valores novos ficam num arquivo só deles: o Postgres não deixa usar um valor de enum na mesma
-- transação em que ele foi criado.
alter type public.task_type add value if not exists 'NFSE_FETCH';
alter type public.document_type add value if not exists 'NFSE_PRESTADAS';
alter type public.document_type add value if not exists 'NFSE_TOMADAS';
