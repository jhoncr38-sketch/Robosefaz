-- Notas canceladas (robô 1.2.32): pedido separado ao SIAT, com Status "Canceladas", e ZIP
-- próprio. Os valores novos ficam num arquivo só deles: o Postgres não deixa usar um valor de
-- enum na mesma transação em que ele foi criado (as funções estão no arquivo seguinte).
alter type public.task_type add value if not exists 'NFCE_CANCELED_EXPORT';
alter type public.task_type add value if not exists 'NFE_ISSUED_CANCELED_EXPORT';
alter type public.task_type add value if not exists 'NFE_RECEIVED_CANCELED_EXPORT';

alter type public.document_type add value if not exists 'NFCE_CANCELADAS';
alter type public.document_type add value if not exists 'NFE_EMITIDAS_CANCELADAS';
alter type public.document_type add value if not exists 'NFE_RECEBIDAS_CANCELADAS';
