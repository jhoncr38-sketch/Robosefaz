-- Conferência rápida (robô 1.2.35): depois de agendar, com o navegador ainda aberto, o robô confere
-- a lista do SIAT e baixa o que já ficou pronto, em vez de fechar e esperar a consulta normal.
-- Parâmetros ajustáveis em Configurações (só o dono da plataforma altera). Robôs mais antigos
-- ignoram estas chaves.
insert into public.app_settings (key, value, description) values
  ('quick_check_seconds', '180'::jsonb,
   'Conferência rápida: tempo máximo, em segundos, que o robô espera depois de agendar para já baixar o que ficou pronto (0 desliga)'),
  ('quick_check_interval_seconds', '60'::jsonb,
   'Conferência rápida: intervalo, em segundos, entre uma conferência e outra')
on conflict (key) do nothing;
