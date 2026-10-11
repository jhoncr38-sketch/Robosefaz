-- Emissão de NFS-e (robô 1.2.37): o robô monta a nota a partir de uma nota real do cliente, assina
-- com o certificado dele e envia à API da prefeitura (Teresina); o cancelamento segue o mesmo caminho.
-- Os valores novos ficam num arquivo só deles: o Postgres não deixa usar um valor de enum na mesma
-- transação em que ele foi criado.
alter type public.task_type add value if not exists 'NFSE_EMIT';
alter type public.task_type add value if not exists 'NFSE_CANCEL';
