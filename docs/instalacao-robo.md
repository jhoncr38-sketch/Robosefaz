# Instalar o robô em um computador

O painel (site) funciona de qualquer lugar. Quem entra no SIAT e baixa as notas é o **robô**, que roda em um computador Windows com os certificados dos clientes instalados. Você pode instalar o robô em mais de um computador: o que estiver ligado pega a fila, e o mesmo cliente nunca é processado por dois robôs ao mesmo tempo.

## Antes de começar

- Windows 10 ou 11, com um usuário **administrador**. O robô usa esse acesso para fazer o Chrome escolher o certificado sozinho.
- Os arquivos **.pfx** e as senhas dos certificados A1 dos clientes.
- Os dados do Supabase: a URL do projeto e a **secret key** (`sb_secret_...`).

## 1. Instalar os certificados dos clientes

Para cada cliente: dê dois cliques no arquivo `.pfx`, escolha **Usuário Atual**, clique em Avançar, digite a senha e conclua. Faça isso com o **mesmo usuário do Windows** que vai rodar o robô.

## 2. Rodar o instalador

Dê dois cliques em **`Instalar-SIAT-Robo-<versão>.exe`**.

- Se aparecer **"O Windows protegeu o computador"**, clique em **Mais informações** e depois em **Executar assim mesmo**. O aviso aparece porque o instalador ainda não tem assinatura digital paga.
- Clique em **Sim** no pedido de administrador.

O assistente mostra:

1. **Boas-vindas**;
2. **Pasta de instalação**: o padrão é `C:\SIAT-Robo`;
3. **Conexão com o painel**: cole a **Secret key** do Supabase. A URL já vem preenchida. Essa tela não aparece em atualizações;
4. **Opções**: impedir a suspensão na tomada (recomendado) e atalho do painel na Área de Trabalho;
5. **Instalação**: copia os arquivos e prepara o robô (Python, bibliotecas, verificação dos certificados). Leva alguns minutos na primeira vez;
6. **Concluído**: o robô já fica ligado, com o ícone ao lado do relógio.

Se algum certificado não estiver instalado, o instalador avisa no final. O relatório completo fica em `C:\SIAT-Robo\storage\logs\instalacao.log`.

**Atualizar:** rode o `.exe` de uma versão nova por cima. Ele para o robô, troca os arquivos, mantém as chaves e as notas, e liga o robô de novo.

**Desinstalar:** em Configurações → Aplicativos → **SIAT Robô** → Desinstalar. As notas em `storage\downloads` **não são apagadas**.

> Sem o `.exe`, também dá para instalar pelo pacote ZIP: extraia numa pasta fixa e rode `instalar-robo.bat`.

## Uso no dia a dia

**O ícone ao lado do relógio** mostra o estado do robô:

| Cor | Significado |
|---|---|
| 🟢 Verde | Ligado, aguardando trabalho |
| 🔵 Azul | Trabalhando no SIAT |
| 🔴 Vermelho | Algum agendamento falhou ou precisa de você |
| ⚪ Cinza | Robô parado |

- **Clique com o botão direito** para ver o menu: abrir o painel, abrir a pasta das notas, ligar ou parar o robô, ver as mensagens do robô.
- **Dois cliques** abrem o painel.
- Aparecem **avisos no canto da tela** quando notas são baixadas neste computador ou quando um agendamento precisa de atenção.
- O Windows esconde ícones novos na setinha **^**. Arraste o ícone para a barra para deixá-lo sempre visível.
- **Fechar o ícone não para o robô.** Para abrir o ícone de novo: menu Iniciar → SIAT Robô.

No **menu Iniciar → SIAT Robô** também ficam: Painel SIAT, Pasta das notas, Ligar robô, Parar robô, Status e verificação, Desinstalar.

- Durante um agendamento, uma janela do Chrome abre sozinha. **Não clique nela nem a feche.** Pode minimizar e usar o computador normalmente.
- Para sair de perto, **bloqueie** a tela (Windows + L). Não faça logoff nem desligue: o robô para junto.
- **Parar robô** termina o trabalho atual e só depois para; nada se perde.
- Os logs ficam em `storage\logs\worker.log`.

## Gerar o instalador (para quem desenvolve)

Na pasta do projeto, rode `gerar-instalador.bat`. Ele precisa do Inno Setup 6 (`winget install JRSoftware.InnoSetup --scope user`) e gera `dist\Instalar-SIAT-Robo-<versão>.exe`, com o Python 3.12 oficial embutido. Antes de gerar uma versão nova, aumente `__version__` em `worker/app/__init__.py`.

## Onde ficam as notas e por quanto tempo

- Os ZIPs ficam **só no computador que fez o download**, em `storage\downloads\CLIENTE\ANO\MÊS\TIPO\`, e **o robô nunca os apaga**. Você apaga quando quiser, direto na pasta. Lembre que a legislação exige guardar os XMLs por 5 anos.
- **60 dias depois do download, o robô apaga sozinho só o histórico:**
  - no Supabase, o registro dos downloads e os agendamentos finalizados, com as tarefas e os logs deles;
  - neste computador, os prints que o robô tira das etapas e dos erros.
- Depois dos 60 dias, a nota some da tela Downloads do painel, mas o arquivo continua na pasta.
- **Nunca são apagados:** clientes, certificados, usuários, a auditoria de cadastros e agendamentos ainda em andamento.
- Logs técnicos (DEBUG) somem depois de 7 dias.
- O prazo é ajustável em `RETENTION_DAYS` no `.env` (0 desliga a limpeza).

## Cliente novo

1. Cadastre o cliente no painel, **com a Inscrição Estadual**, e associe o certificado.
2. Instale o `.pfx` do cliente em **todos** os computadores que rodam o robô (passo 1).
3. Abra **menu Iniciar → SIAT Robô → Status e verificação** e responda **s** para conferir se o certificado aparece como instalado.

## Problemas comuns

- **"Certificado NÃO instalado neste Windows":** instale o `.pfx` do cliente com o mesmo usuário que roda o robô.
- **O botão Baixar diz que o arquivo não está neste computador:** a nota foi baixada por outro computador. Pegue lá ou refaça o agendamento neste; o SIAT reaproveita o pedido existente.
- **Computador desligado no meio de um job:** nada se perde. Se outro computador com o robô estiver ligado, ele assume o job em cerca de 3 minutos. Se não houver outro, o job continua quando este computador ligar de novo. Um cancelamento feito no painel nesse meio tempo é respeitado.
- **Uma nota não baixa (por exemplo, sem botão de download no SIAT):** as outras notas continuam sendo baixadas. O robô tenta essa nota de novo em 5, 15, 30 e 60 minutos; depois de 5 falhas, marca a nota com erro para você conferir no SIAT.
