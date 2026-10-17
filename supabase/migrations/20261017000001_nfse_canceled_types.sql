-- NFS-e canceladas (robô 1.2.39): o cancelamento lido na NFS-e Nacional também vai para um ZIP próprio do
-- mês da nota ("EMPRESA - NFS-e tomadas canceladas - 09-2026 - CLI000006.zip"), com o XML da nota e o XML
-- do evento, como já acontece com as canceladas do SIAT. Esse ZIP não entra no índice (a nota já está lá,
-- marcada pelo evento). Os valores novos ficam num arquivo só deles: o Postgres não deixa usar um valor de
-- enum na mesma transação em que ele foi criado (as funções estão no arquivo seguinte).
alter type public.document_type add value if not exists 'NFSE_PRESTADAS_CANCELADAS';
alter type public.document_type add value if not exists 'NFSE_TOMADAS_CANCELADAS';
