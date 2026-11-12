-- Emissão de NFS-e liberada para todos os escritórios (pedido do dono da plataforma em 12/11/2026).
-- - os escritórios atuais passam a ter a emissão ligada;
-- - os escritórios novos já nascem com ela ligada;
-- - o dono continua podendo desligar um escritório no quadro da tela Emitir NFS-e (set_org_nfse_emit).

alter table public.organizations alter column nfse_emit_enabled set default true;

update public.organizations set nfse_emit_enabled = true where not nfse_emit_enabled;
