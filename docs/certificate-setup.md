# Configuração de certificados digitais

Este guia explica como o robô usa o certificado A1 de cada cliente para entrar
no SIAT Web, sem burlar nenhum mecanismo de segurança do portal.

## Como o SIAT autentica com certificado

Fluxo observado em um login real (setembro/2026):

```
/painel-aplicacoes/login
  -> https://siatweb-certificado.sefaz.pi.gov.br/auth/realms/nsw-sefaz/...  ("Entrar no nsw-sefaz", Keycloak)
  -> /painel-aplicacoes/callback
  -> /painel-aplicacoes/main
```

O certificado é pedido pelo servidor de autenticação via **TLS**: quem mostra a
lista é a **janela nativa do Chrome** ("Selecione um certificado"), não a página.
O Lacuna Web PKI aparece no código do SIAT, mas para outras funções (assinatura
de documentos); não é necessário para o login.

O Playwright não consegue interagir com a janela nativa. Há dois modos:

- **Manual (padrão):** o robô abre o SIAT, clica em *Certificado Digital* e o job
  fica em `waiting_certificate` ("Aguardando seleção do certificado digital.").
  Você escolhe o certificado na janela do robô e ele continua sozinho ao chegar
  em `/painel-aplicacoes/main`.
- **Automático, com a política do Chrome:** `AutoSelectCertificateForUrls` para
  `https://siatweb-certificado.sefaz.pi.gov.br`, filtrando pelo titular do
  certificado do cliente. Veja a seção
  [Seleção automática](#seleção-automática-pela-política-do-chrome-opcional).
  Como a máquina tem certificados de vários clientes, use
  `CHROME_POLICY_MODE=per_job`: a entrada é gravada só durante o job daquele
  cliente e removida em seguida.

O robô também trata, se aparecerem, o diálogo de certificados dentro da página
(Web PKI, "Selecione um Certificado") e o pedido "Permitir" do Web PKI — neste
último caso sempre pedindo a sua ação. CAPTCHA e 2FA viram
`manual_action_required`.

## Passo a passo por cliente

### 1. Instale o A1 no Windows da máquina do worker

Dê dois cliques no arquivo `.pfx`/`.p12` → **Usuário Atual** → informe a senha →
deixe o Windows escolher o repositório (**Pessoal**). Confirme em
`certmgr.msc` → *Pessoal → Certificados*, ou no PowerShell:

```powershell
Get-ChildItem Cert:\CurrentUser\My | Format-List Subject, Issuer, Thumbprint, NotAfter, HasPrivateKey
```

Em Windows, o worker **exige** que o certificado cadastrado (por thumbprint ou
número de série) esteja em `Cert:\CurrentUser\My` com chave privada. Caso
contrário, o job fica `certificate_required` e o navegador nem é aberto.

### 2. Web PKI (somente se o SIAT pedir)

O login não usa o Web PKI. Instale a extensão e o aplicativo da Lacuna apenas se
alguma tela do SIAT pedir. O robô inicia o navegador **sem**
`--disable-extensions`, então extensões instaladas no perfil funcionam.

### 3. Cadastre o certificado no painel

*Certificados → Associar certificado* (ou aba **Certificado** do cliente):

- Opcionalmente selecione o `.pfx` e informe a senha e clique em **Ler**: a API
  do worker lê titular, emissor, série, thumbprint e validade **em memória**. O
  arquivo não é salvo em lugar nenhum.
- Marque **Guardar a senha no cofre** apenas se precisar dela depois. A senha
  vai direto para o worker e é gravada no **Windows Credential Manager**
  (`keyring`, serviço `siat-automation`, usuário `certificate/{id}`). Sem cofre
  do sistema, usa `storage/secrets/secrets.enc.json` cifrado com Fernet
  (`SECRET_ENCRYPTION_KEY`). O banco guarda só o indicador `has_secret`.
- **Seleção manual do certificado**: marque se o cliente tiver vários
  certificados parecidos ou se você quiser sempre escolher manualmente.

Cada cliente tem **um** certificado ativo; ao associar um novo, o anterior é
desativado e fica no histórico.

### 4. Prepare o perfil do navegador (uma vez)

Na aba **Certificado** do cliente, clique em **Abrir perfil do navegador**. O
worker abre o Chrome com o perfil exclusivo
`storage/browser_profiles/{client_id}/chrome` na tela de login do SIAT. Nele:

1. Clique em **Certificado Digital** e escolha o certificado do cliente na
   janela do Chrome.
2. Confirme que chegou ao painel do SIAT e feche o navegador.

Os cookies da sessão ficam no perfil do cliente; enquanto válidos, o robô
reaproveita a sessão sem pedir o certificado de novo.

## Perfis de navegador

- Cada cliente usa seu próprio `user_data_dir`:
  `storage/browser_profiles/{client_id}/`.
- `profile.json` registra o vínculo cliente ↔ certificado. Se o arquivo indicar
  outro cliente, a execução é bloqueada com `SECURITY_CLIENT_MISMATCH`.
- Um lock (`.siat.lock`) impede dois processos no mesmo perfil, e a fila nunca
  entrega dois jobs do mesmo cliente ao mesmo tempo.

## Seleção automática pela política do Chrome (opcional)

A política `AutoSelectCertificateForUrls` faz o Chrome escolher um certificado
TLS automaticamente para uma URL, com filtros por **SUBJECT** e/ou **ISSUER**. É
uma configuração do dono da máquina, suportada oficialmente pelo Chrome e pelo
Edge.

O `ChromeCertificatePolicyService` (`worker/app/certificates/chrome_policy.py`):

- gera a entrada, por exemplo:
  `{"pattern":"https://siatweb-certificado.sefaz.pi.gov.br","filter":{"SUBJECT":{"CN":"EMPRESA A LTDA:11222333000181"},"ISSUER":{"CN":"AC XYZ RFB v5"}}}`
- mostra a chave de registro e um arquivo `.reg` para revisão em
  *Certificados → Política do Chrome*;
- **não grava nada** no Registro sem `confirm=True` **e**
  `CHROME_POLICY_ALLOW_WRITE=true`;
- guarda em `storage/browser_profiles/_chrome_policy_state.json` quais valores
  criou, e só remove esses.

Chaves usadas (escopo do usuário, não exige administrador):

| Canal | Chave |
|---|---|
| Chrome | `HKCU\Software\Policies\Google\Chrome\AutoSelectCertificateForUrls` |
| Edge | `HKCU\Software\Policies\Microsoft\Edge\AutoSelectCertificateForUrls` |
| Chromium | `HKCU\Software\Policies\Chromium\AutoSelectCertificateForUrls` |

**Atenção:** a política vale para o navegador inteiro, não por perfil. Com vários
clientes, há dois caminhos:

- `CHROME_POLICY_MODE=per_job` + `CHROME_POLICY_ALLOW_WRITE=true`: o worker grava
  a entrada do certificado do cliente só durante o job e remove ao terminar.
  Exige `MAX_PARALLEL_JOBS=1`.
- Aplicar manualmente o `.reg` revisado, quando a máquina atende um único
  certificado.

Algumas instalações do Chrome só respeitam políticas em `HKLM` (máquinas em
domínio). Nesse caso aplique o `.reg` manualmente como administrador.

## Validade e alertas

- Status: **válido**, **vencendo** (≤ 30 dias, configurável em
  *Configurações*) e **vencido**.
- O worker recalcula os status a cada 5 minutos e cria notificações diárias
  (*"Certificado da Empresa X vence em 12 dias."*) para administradores e
  operadores.
- Certificado vencido: o job vai para `certificate_required` com o código
  `CERTIFICATE_EXPIRED` e não é repetido automaticamente.

## O que nunca é registrado

Senhas, PINs, conteúdo de chave privada e tokens são removidos de todos os logs
(`worker/app/logs/redaction.py`), inclusive de metadados JSON.
