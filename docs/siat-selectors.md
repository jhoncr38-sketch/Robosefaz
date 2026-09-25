# Seletores do SIAT: como calibrar e manter

Todo o conhecimento sobre a interface do SIAT fica em um único arquivo:
`worker/app/automation/siat/selectors.py`. Nenhum outro módulo contém textos ou
seletores do portal.

## O que já foi confirmado no portal

Os textos abaixo foram extraídos do código público da tela de login
(`/painel-aplicacoes`, Nuxt + Vuetify) e já estão nos padrões:

| Elemento | Texto no portal |
|---|---|
| Diálogo de certificados (Web PKI) | `Selecione um Certificado`, linhas `titular - emissor - e-mail` |
| Autorização do Web PKI | `O site ... deseja acessar seus certificados digitais.` / `Permitir` |
| Seleção de contribuinte | `Selecionar Contribuinte`; colunas `Inscrição`, `CPF/CNPJ`, `Nome/Razão Social`, `Situação Cadastral`, `Ações` (ícone `selecionar`) |
| Usuário logado | `Último acesso`, `Login com Certificado` |

O portal já valida CNPJ **alfanumérico**; o sistema também valida (Python, SQL e
TypeScript).

## Caminho até a exportação (confirmado com o usuário em 24/09/2026)

| Etapa | Onde | Texto / seletor |
|---|---|---|
| 1 | Painel de aplicações (`/painel-aplicacoes/main`) | card **e-AGEAT** (`module_link`) |
| 2 | e-AGEAT (`/eageat/jsp/...`) | às vezes **"Error 500"** ou **"Usuário não identificado"**: o robô fecha a aba e clica no card de novo (até `MODULE_OPEN_ATTEMPTS`). O botão "Efetuar login" **não** é usado (leva à página pública) |
| 3 | e-AGEAT | menu **Autorregularização** → **SIAT** (`eageat_menu_root`, `eageat_menu_siat`) |
| 4 | SIAT web legado (`webas.sefaz.pi.gov.br/siatweb/faces/...`) | **Autoatendimento** → **NFC-e** → **Consultar/Exportar NFC-e**; **NF-e** → **Consultar/Exportar NF-e** (não a "Detalhada") |
| 5 | Formulário NFC-e ("Consultar NFCE") | Contribuinte como Emitente, **Inscrição**, Tipo de nota **Saída**, Status (`NFCE_STATUS`: ativas/canceladas/todas), Data de Emissão Inicial/Final, **Agendar exportação** |
| 6 | Formulário NF-e ("Consultar NFE") | Contribuinte como **Emitente** (emitidas) ou **Destinatário** (recebidas), Inscrição, datas, **Agendar exportação** |
| 7 | Listas "Agendamentos de exportação NFCe" / "Exportação de Notas Fiscais Agendadas" | colunas **ID, Situação, Data de criação, CNPJ, IE, Data processamento**; botões Info / **Download** / Excluir |

### Identificação do contribuinte

- No painel: CNPJ no cabeçalho ("CONTRIBUINTE ... 36.145.344/0001-36").
- No SIAT web: **não há CNPJ**. O robô valida pela **Inscrição Estadual** do
  cadastro do cliente: a IE precisa existir no select "Inscrição" (senão
  `SECURITY_CLIENT_MISMATCH`) e cada linha baixada precisa ter a mesma IE na
  coluna "IE". Cliente sem IE cadastrada → `INVALID_CONFIGURATION`.

### Identificação do agendamento

A lista não mostra período nem tipo de documento. O robô lê os IDs antes de
clicar em "Agendar exportação" e grava o **ID novo** que aparece depois. Se o ID
novo vier com IE de outro contribuinte, a execução é bloqueada.

### Ainda a confirmar em execução real

- Campos do formulário NF-e após escolher Emitente/Destinatário (o robô procura
  "Inscrição" e "Data de Emissão Inicial/Final"; a simulação mostra a tela).
- Texto exato da mensagem após agendar (`export_success_message`).
- Paginação das listas (`legacy_paginator_next`).

## Sobrescrever sem alterar código

Crie `worker/config/siat_selectors.json` a partir de
`worker/config/siat_selectors.example.json` e informe só as chaves que mudam.
Os valores são **expressões regulares** (sem diferenciar maiúsculas); listas são
aceitas em `export_menu_path`. Chaves iniciadas com `_` são comentários.

```json
{
  "module_link": "e-?\\s?ageat",
  "export_menu_path": ["documentos\\s+fiscais", "exporta[çc][ãa]o\\s+de\\s+xml"],
  "export_submit_button": "^\\s*agendar\\s*$"
}
```

Regex inválida faz o worker falhar ao iniciar, com o nome da chave no erro.

## Gravar a rotina com o Playwright Inspector

```powershell
cd worker
.venv\Scripts\python.exe -m app.tools.inspect_siat --client-code CLI000001
```

O Chrome abre no perfil exclusivo do cliente com o **Playwright Inspector**.
Use **Record**, faça o caminho manualmente até o agendamento e copie os textos
dos botões/rótulos para o JSON. Prefira sempre textos visíveis (`get_by_role`,
`get_by_label`, `get_by_text`) a classes CSS.

## Validar antes de agendar de verdade

1. Deixe `AUTOMATION_DRY_RUN=true` (padrão): o robô navega, seleciona o
   contribuinte e preenche os formulários, mas **não** clica no botão final.
2. Use `AUTOMATION_SCREENSHOTS=true` para ter uma imagem de cada etapa em
   `storage/screenshots/{job}/`.
3. Com `AUTOMATION_HEADLESS=false`, acompanhe o navegador.
4. Quando o formulário estiver correto, mude para `AUTOMATION_DRY_RUN=false`.

## Testes

`worker/tests/mock_siat/site.py` é um SIAT simulado com os textos reais do login e
uma área de exportação no formato dos padrões. `test_siat_integration.py` roda o
Playwright contra ele no domínio `siat-mock.invalid` (que nunca resolve), então
nenhuma requisição chega à SEFAZ. Ao calibrar novos textos, ajuste o mock para
manter os testes representativos.
