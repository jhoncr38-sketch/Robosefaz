# SIAT Automação

Sistema para automatizar rotinas do **SIAT Web da SEFAZ-PI**: agenda a exportação
de **NFC-e**, **NF-e emitidas** e **NF-e recebidas** por cliente e competência,
acompanha o processamento da SEFAZ e baixa os ZIPs automaticamente, organizando-os
por cliente e mês.

- Painel web com login, perfis de acesso, clientes, certificados, fila em tempo
  real, downloads, histórico, erros, usuários e configurações.
- Robô Python + Playwright com **perfil de navegador exclusivo por cliente**.
- Dois robôs separados: **Scheduler** (agenda e fecha o navegador) e
  **Collector** (volta depois, verifica e baixa).
- Proteção contra cliente errado, controle de duplicidade, retry com backoff,
  lock de fila no banco, auditoria e notificações.
- Nenhum CAPTCHA, 2FA ou autorização do portal é burlado: essas etapas viram
  **"aguardando intervenção do usuário"**.

---

## Arquitetura

```
Painel Web (Next.js 16)  ──►  Supabase (Auth + PostgreSQL + Realtime + RLS)
        │                              ▲
        │ JWT do usuário               │ service role
        ▼                              │
API FastAPI  ────────────────►  Fila (automation_jobs + locks SKIP LOCKED)
                                        │
                                        ▼
                         Worker Python (python -m app.worker)
                           ├─ Scheduler (Robô 1): queued → waiting_sefaz
                           └─ Collector (Robô 2): waiting_sefaz → completed
                                        │
                                        ▼
                     Playwright + Chrome (perfil por cliente) ──► SIAT Web
```

| Pasta | Conteúdo |
|---|---|
| `apps/web` | Painel Next.js (App Router, TypeScript, Tailwind, shadcn/ui, lucide) |
| `worker/app/api` | Endpoints FastAPI |
| `worker/app/jobs` | Modelos, máquina de estados, retry, duplicidade, repositório, Scheduler e Collector |
| `worker/app/automation` | `AutomationProvider` (interface) e `siat/` (implementação SIAT) |
| `worker/app/automation/siat/selectors.py` | **Único** lugar com textos/seletores do portal |
| `worker/app/browser` | Sessão Playwright persistente, lock de perfil, screenshots |
| `worker/app/certificates` | Gestor, seletor, perfil, cofre de senha, PFX, política do Chrome |
| `worker/app/downloads` | Organização dos arquivos + SHA-256 |
| `worker/app/logs` | Logs no banco com redação de dados sensíveis |
| `supabase/migrations` | Schema, funções/RPCs, RLS, Realtime e Storage privado |
| `supabase/tests` | Testes das migrations em Postgres real (PGlite) |
| `storage/` | Downloads, perfis de navegador, screenshots de erro (fora do Git) |
| `docs/` | Guias de certificado e de calibração de seletores |

### Novos portais

`worker/app/automation/base.py` define `AutomationProvider`
(`login`, `select_company`, `schedule`, `check_status`, `download`).
`SiatAutomationProvider` é a primeira implementação; e-CAC, prefeituras ou outras
SEFAZ entram registrando um novo provider em `automation/registry.py` e usando
`clients.provider`.

---

## Pré-requisitos

- Windows 10/11 (o worker usa o repositório de certificados e o Credential Manager)
- Node.js 20+ (testado com 24) e npm
- Python 3.12+
- Google Chrome instalado (recomendado para o Lacuna Web PKI usado pelo SIAT)
- Um projeto Supabase

---

## Instalação

> **Só o robô, em um computador do escritório:** use o instalador `instalar-robo.bat`.
> Ele prepara tudo e faz o robô iniciar junto com o Windows.
> Passo a passo em [docs/instalacao-robo.md](docs/instalacao-robo.md).
> As instruções abaixo são para desenvolvimento.

```powershell
git clone <repo> siat-automation
cd siat-automation
copy .env.example .env
copy apps\web\.env.example apps\web\.env.local
```

### Painel

```powershell
cd apps\web
npm install
```

### Worker / API

```powershell
cd worker
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m playwright install chromium
.venv\Scripts\python.exe -m app.tools.generate_key   # cole o valor em SECRET_ENCRYPTION_KEY no .env
```

---

## Supabase

1. Crie o projeto e anote **URL**, **anon key** e **service role key**
   (*Project Settings → API*).
2. Aplique as migrations **em ordem**:
   - com a CLI: `supabase link --project-ref <ref>` e `supabase db push`, ou
   - no *SQL Editor*, executando os arquivos de `supabase/migrations/` em ordem.
   As migrations criam tabelas, índices, RPCs, RLS, publicação Realtime e os
   buckets privados `certificates` e `fiscal-downloads`.
3. *Authentication → Sign In / Providers*: **desative cadastro público** (novos
   usuários só pela tela Usuários).
4. *Authentication → URL Configuration*: `Site URL = http://localhost:3000` e
   adicione `http://localhost:3000/auth/callback` em *Redirect URLs* (recuperação
   de senha e convites).
5. Crie o primeiro usuário em *Authentication → Users → Add user*. **O primeiro
   usuário vira administrador automaticamente**; os demais entram como
   visualizador, a menos que o admin defina outro papel.

---

## Variáveis de ambiente

Todas estão documentadas em [`.env.example`](.env.example). Principais:

| Variável | Onde | Uso |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Auth e dados com RLS |
| `WORKER_API_URL` | web (servidor) | API FastAPI |
| `SUPABASE_SERVICE_ROLE_KEY` | web (servidor, opcional) / worker | Criar usuários / fila do worker |
| `SUPABASE_ANON_KEY` | worker | A API executa RPCs com o JWT do usuário |
| `SECRET_ENCRYPTION_KEY` | worker | Cofre em arquivo (fallback do Credential Manager) |
| `AUTOMATION_HEADLESS` | worker | `false` = navegador visível |
| `AUTOMATION_DRY_RUN` | worker | `true` = não clica no botão final de agendamento |
| `AUTOMATION_SCREENSHOTS` | worker | screenshot de cada etapa |
| `MAX_PARALLEL_JOBS` | worker | navegadores simultâneos (padrão 1) |
| `PAGE_LOAD_TIMEOUT` / `ACTION_TIMEOUT` / `DOWNLOAD_TIMEOUT` | worker | timeouts em ms |

A service role **nunca** vai para o navegador: no painel só é lida em código
`server-only`, sem prefixo `NEXT_PUBLIC_`. `.env` está no `.gitignore`.

---

## Como executar

**Atalhos (Windows):** na pasta do projeto, dê dois cliques em:

- `iniciar-api-e-painel.bat`: abre a API e o painel em duas janelas.
- `iniciar-worker.bat`: pede permissão de administrador (necessária para a regra do
  Chrome que escolhe o certificado) e inicia o worker na pasta certa.

Os atalhos chamam o Python do projeto diretamente, então funcionam mesmo com a
execução de scripts do PowerShell bloqueada.

Ou manualmente, três processos em terminais separados:

```powershell
# 1. Painel
cd apps\web
npm run dev                         # http://localhost:3000

# 2. API
cd worker
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
# http://127.0.0.1:8000/docs  ·  GET /health -> {"status","browser","database"}

# 3. Worker (Scheduler + Collector)
cd worker
.venv\Scripts\python.exe -m app.worker                 # ou --mode scheduler / --mode collector
```

### Endpoints da API

| Método | Rota | Papel |
|---|---|---|
| GET | `/health` | público |
| GET | `/worker/status` | viewer |
| GET | `/jobs`, `/jobs/{id}` | viewer |
| POST | `/jobs` (lote), `/clients/{id}/automation` | operator |
| POST | `/jobs/{id}/cancel`, `/jobs/{id}/confirm` | operator |
| POST | `/jobs/{id}/retry` | admin |
| GET | `/downloads/{id}/file` | viewer |
| POST | `/certificates/inspect`, PUT/DELETE `/certificates/{id}/secret` | admin |
| GET | `/certificates/store`, `/certificates/{id}/chrome-policy(.reg)` | admin |
| POST | `/certificates/{id}/chrome-policy/apply`, `/clients/{id}/browser-profile/open` | admin |

Todas as rotas (exceto `/health`) exigem `Authorization: Bearer <JWT do Supabase>`.

---

## Deploy do painel na Vercel

Somente o **painel** (`apps/web`) vai para a Vercel. A API e o worker rodam no PC
onde os certificados estão instalados; o worker pega as tarefas pelo Supabase.

1. Importe o repositório na Vercel.
2. **Settings → Build and Deployment → Root Directory = `apps/web`** e
   **Framework Preset = Next.js**. Sem isso o build "passa" em segundos sem gerar
   nada e o site responde `404: NOT_FOUND`.
3. **Settings → Environment Variables** (Production e Preview), **com valor**:

   | Variável | Obrigatória | Observação |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | sim | URL do projeto Supabase |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sim | chave pública (anon / publishable) |
   | `SUPABASE_SERVICE_ROLE_KEY` | não | só para criar usuários na tela Usuários; marque como Sensitive |

   Não importe o `.env.example` (os valores vêm vazios) e não envie variáveis do
   worker (`SECRET_ENCRYPTION_KEY`, `AUTOMATION_*`...). `NEXT_PUBLIC_*` entram no
   build: depois de alterar, faça **Redeploy**. Se a tela de login mostrar
   "Supabase não configurado", as variáveis estavam vazias no build.
4. No Supabase, **Authentication → URL Configuration → Redirect URLs**: adicione
   `https://SEU-PROJETO.vercel.app/auth/callback`.

Com o painel na Vercel ainda dependem da API local (`WORKER_API_URL`, inacessível
da nuvem): download do ZIP pelo painel, "Ler PFX", "Guardar senha", "Abrir perfil
do navegador" e o status da API em Configurações. Criar automações, fila em tempo
real, histórico e erros funcionam normalmente.

---

## Uso

### Cadastrar cliente

*Clientes → Novo cliente*: razão social, nome fantasia, CNPJ (numérico ou
alfanumérico, validado e salvo sem pontuação), IE, UF, e-mail, telefone e quais
documentos o cliente usa (NFC-e, NF-e emitidas, NF-e recebidas). O código interno
(`CLI000001`, ...) é gerado automaticamente.

### Configurar certificado

Siga **[docs/certificate-setup.md](docs/certificate-setup.md)**. Resumo: instale o
A1 no Windows do worker, cadastre-o em *Certificados* (a leitura do PFX é
opcional e nada é armazenado), clique em **Abrir perfil do navegador** e
autorize o Web PKI uma vez.

### Iniciar automação

- **Em lote**: *Automação SIAT* (ou **Processar competência** no Dashboard) →
  escolha a competência (ex.: `08/2026` → período `01/08/2026` a `31/08/2026`) →
  filtre (ativos, certificado válido, com NFC-e, com NF-e) → marque os clientes
  ou *Selecionar todos* → **Processar selecionados** → confirme.
- **Um cliente**: página do cliente → **Executar automação**.

É criado um job por cliente. O robô processa um cliente por vez com o perfil e o
certificado desse cliente. Acompanhe em **Fila de processamento**, atualizada em
tempo real pelo Supabase Realtime (cinza = aguardando, azul = processando,
amarelo = aguardando SEFAZ, verde = concluído, vermelho = erro, laranja =
intervenção manual).

### Duplicidade

A chave `cliente + competência + tipo de documento + operação` é única entre
solicitações ativas (índice único parcial no banco). Repetir o pedido retorna
**"Exportação já agendada."**. Administradores podem **Forçar novo agendamento**;
a solicitação anterior é marcada como substituída.

### Intervenção manual

Quando o portal pede algo que não deve ser automatizado (autorização do Web PKI,
janela nativa de certificado, CAPTCHA, 2FA), o job fica laranja com a mensagem
*"A automação está aguardando sua intervenção."*. Resolva no navegador aberto na
máquina do worker e clique em **Continuar automação**. Sem resposta em
`MANUAL_ACTION_TIMEOUT`, o job falha com `MANUAL_ACTION_REQUIRED`.

### Proteção contra cliente errado

Antes de agendar, baixar ou qualquer alteração, o robô confirma que o contribuinte
aberto no SIAT tem o CNPJ do job. Divergência → encerra a sessão, não executa e
registra `TAXPAYER_MISMATCH` / `SECURITY_CLIENT_MISMATCH` (sem retry).

### Retry

Até 3 retentativas automáticas com espera de 10 s, 30 s e 60 s (configurável). Não
são repetidos: `TAXPAYER_MISMATCH`, `SECURITY_CLIENT_MISMATCH`,
`CERTIFICATE_EXPIRED`, `CERTIFICATE_REQUIRED`, `INVALID_CONFIGURATION`,
`MANUAL_ACTION_REQUIRED`. Administradores podem **Reprocessar** jobs com erro.

---

## Estrutura de downloads

```
storage/downloads/
└── CLI000001/
    └── 2026/
        └── 08/
            ├── NFCE/            CLI000001_2026-08_NFCE.zip
            ├── NFE_EMITIDAS/    CLI000001_2026-08_NFE_EMITIDAS.zip
            └── NFE_RECEBIDAS/   CLI000001_2026-08_NFE_RECEBIDAS.zip
```

- SHA-256 de cada arquivo registrado em `downloads.checksum`.
- Arquivo idêntico não é duplicado; conteúdo novo ganha sufixo `_2`, `_3`.
- A extensão vem do conteúdo (assinatura ZIP/XML). Se o portal devolver uma
  página HTML (sessão expirada/erro) no lugar do arquivo, o download falha.
- O painel baixa os arquivos por `/api/downloads/{id}`, com autenticação, via API
  do worker.

Screenshots de erro: `storage/errors/{jobid}_{datahora}.png` (caminho gravado no
job). Screenshots de etapas (modo debug): `storage/screenshots/{jobid}/`.

---

## Testes e qualidade

```powershell
# Worker: unidade + integração Playwright contra SIAT simulado (sem internet)
cd worker
.venv\Scripts\python.exe -m pytest

# Migrations em Postgres real (PGlite): RLS, RPCs, duplicidade, lock, auditoria
cd supabase\tests
npm install
npm test

# Painel
cd apps\web
npm run lint
npm run build
npm test
```

Cobertura: validação de CNPJ, competência, estrutura de pastas e nomes, controle
de duplicidade, máquina de estados, retry, permissões por papel (API e banco),
intervenção manual, cofre de segredos, leitura de PFX, política do Chrome,
seleção de certificado e contribuinte, Scheduler/Collector com mocks e o fluxo
completo no navegador. **Nenhum teste acessa o SIAT real**: o mock usa o domínio
`siat-mock.invalid`.

---

## Primeira execução recomendada

1. `AUTOMATION_DRY_RUN=true`, `AUTOMATION_HEADLESS=false`, `AUTOMATION_SCREENSHOTS=true`.
2. Cadastre 1 cliente e 1 certificado; prepare o perfil do navegador.
3. Rode 1 competência para esse cliente e acompanhe o navegador. O robô faz login,
   seleciona o contribuinte e preenche os formulários de NFC-e e NF-e sem enviar.
4. Calibre os seletores da área de exportação se necessário
   ([docs/siat-selectors.md](docs/siat-selectors.md)).
5. Mude para `AUTOMATION_DRY_RUN=false` e agende de verdade. O job vai para
   *Aguardando SEFAZ*; o Collector consulta a cada 30 min (configurável) e baixa
   os ZIPs.
6. Só então amplie para lotes.

---

## Resolução de problemas

| Sintoma | Causa provável / solução |
|---|---|
| Login redireciona para `/login?error=config` | Faltam `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` em `apps/web/.env.local` |
| `/health` com `"database": false` | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` ausentes ou incorretos no `.env` |
| `/health` com `"browser": false` | Rode `playwright install chromium`; com `BROWSER_CHANNEL=chrome`, instale o Google Chrome |
| Configurações: "API indisponível" | Inicie o uvicorn e confira `WORKER_API_URL` |
| Job em `certificate_required` | Sem certificado ativo, vencido ou não instalado em `Cert:\CurrentUser\My` com chave privada |
| Job parado em `waiting_certificate` | Autorize o Web PKI ou escolha o certificado na janela aberta no worker e clique em **Continuar automação** |
| `SELECTOR_NOT_FOUND` | O portal mudou ou a área de exportação precisa de calibração: veja o screenshot em `storage/errors` e ajuste `siat_selectors.json` |
| `TAXPAYER_MISMATCH` | O CNPJ exibido no SIAT não é o do cliente; confira CNPJ/IE e o acesso do certificado a esse contribuinte |
| `PROFILE_IN_USE` | Outro processo usa o perfil; feche o Chrome do robô (lock de processo morto é liberado sozinho) |
| Job preso após queda do worker | Locks sem atividade por `STALE_LOCK_MINUTES` voltam para a fila automaticamente |
| `COLLECTOR_EXHAUSTED` | A SEFAZ não disponibilizou o arquivo após `collector_max_checks` consultas; reprocesse |
| Senha não salva no cofre | Sem Credential Manager disponível: defina `SECRET_ENCRYPTION_KEY` |
| Fila não atualiza sozinha | Confira se a migration 3 adicionou as tabelas à publicação `supabase_realtime` |

---

## Segurança

- RLS em todas as tabelas; escrita de jobs só por RPCs `security definer` com
  checagem de papel; funções da fila só para `service_role`.
- Papel do usuário vem de `app_metadata` (o usuário não consegue se promover no
  signup) e o próprio usuário não altera seu papel.
- Senhas de certificado só no cofre do worker; nunca no banco nem em logs.
- Buckets de Storage privados (`certificates` sem acesso para usuários).
- Auditoria (`audit_logs`) de clientes, certificados, automações, cancelamentos,
  reprocessamentos, intervenções e downloads, com usuário e IP quando disponível.
