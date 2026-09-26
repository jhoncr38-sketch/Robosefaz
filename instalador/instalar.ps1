#Requires -Version 5.1
<#
  Instalador do robô SIAT Automação (executado por instalar-robo.bat, como administrador).

  Etapas (nada é alterado sem avisar; itens do sistema pedem confirmação):
   1. Python 3.12 e Google Chrome (instala pelo winget, se faltar e você concordar)
   2. Ambiente Python do worker e dependências
   3. Arquivo .env (chaves do Supabase, pasta de downloads)
   4. Verificação completa (Supabase, Chrome, pasta, certificados dos clientes)
   5. Início automático junto com o Windows (Agendador de Tarefas)
   6. (opcional) impedir que o computador entre em suspensão na tomada

  Pode ser executado de novo a qualquer momento para reparar ou reconfigurar.

  -Silencioso: sem perguntas (usado pelo Instalar-SIAT-Robo.exe, que já gravou o .env).
#>
param(
    [switch]$Silencioso,          # sem perguntas; o .env já deve existir
    [string]$PythonInstalador,    # instalador oficial do Python 3.12 embutido no .exe
    [string]$Conexao,             # (silencioso) arquivo temporário: 1ª linha URL, 2ª linha secret key
    [switch]$SemSuspensao,        # (silencioso) impede a suspensão na tomada
    [switch]$Iniciar,             # (silencioso) liga o robô no fim
    [string]$Log                  # (silencioso) arquivo com o registro da instalação
)
$ErrorActionPreference = 'Stop'
if ($Silencioso -and $Log) { Start-Transcript -LiteralPath $Log -Force | Out-Null }

$Raiz     = Split-Path -Parent $PSScriptRoot
$Worker   = Join-Path $Raiz 'worker'
$Venv     = Join-Path $Worker '.venv'
$Py       = Join-Path $Venv 'Scripts\python.exe'
$EnvFile  = Join-Path $Raiz '.env'
$Exemplo  = Join-Path $Raiz '.env.example'
$Servico  = Join-Path $PSScriptRoot 'robo-servico.ps1'
$TaskName = 'SIAT Automacao - Robo'

function Titulo([string]$t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok([string]$t)     { Write-Host "  [OK] $t" -ForegroundColor Green }
function Aviso([string]$t)  { Write-Host "  [ATENÇÃO] $t" -ForegroundColor Yellow }
function Falha([string]$t) {
    Write-Host "  [ERRO] $t" -ForegroundColor Red
    Write-Host ''
    Write-Host 'Instalação interrompida. Corrija o problema e execute a instalação de novo.'
    if ($Silencioso -and $Log) { Stop-Transcript | Out-Null }
    exit 1
}
function SimNao([string]$texto, [bool]$padraoSim = $true, $respostaSilenciosa = $null) {
    if ($Silencioso) { if ($null -ne $respostaSilenciosa) { return [bool]$respostaSilenciosa } return $padraoSim }
    $sufixo = if ($padraoSim) { '[S/n]' } else { '[s/N]' }
    $r = (Read-Host "  $texto $sufixo").Trim().ToLower()
    if ($r -eq '') { return $padraoSim }
    return $r.StartsWith('s')
}
function Pergunta([string]$texto, [string]$padrao = '') {
    $r = if ($padrao) { Read-Host "  $texto [$padrao]" } else { Read-Host "  $texto" }
    if ([string]::IsNullOrWhiteSpace($r)) { return $padrao }
    return $r.Trim()
}

# --- .env: leitura/gravação preservando comentários ---------------------------
function Ler-Env([string]$caminho) {
    $lista = New-Object 'System.Collections.Generic.List[string]'
    if (Test-Path $caminho) { foreach ($l in (Get-Content -LiteralPath $caminho -Encoding UTF8)) { $lista.Add($l) } }
    return , $lista  # vírgula: devolve a lista (e não um vetor de tamanho fixo)
}
function Valor-Env($linhas, [string]$chave) {
    foreach ($l in $linhas) { if ($l -match "^\s*$([regex]::Escape($chave))=(.*)$") { return $Matches[1].Trim() } }
    return ''
}
function Definir-Env($linhas, [string]$chave, [string]$valor) {
    # troca TODAS as ocorrências (o .env.example repete chaves nas seções do painel e do robô)
    $achou = $false
    for ($i = 0; $i -lt $linhas.Count; $i++) {
        if ($linhas[$i] -match "^\s*$([regex]::Escape($chave))=") { $linhas[$i] = "$chave=$valor"; $achou = $true }
    }
    if (-not $achou) { $linhas.Add("$chave=$valor") }
}
function Gravar-Env($linhas, [string]$caminho) {
    [System.IO.File]::WriteAllLines($caminho, $linhas, (New-Object System.Text.UTF8Encoding $false))
}

# --- Python ---------------------------------------------------------------------
function Achar-Python312 {
    $candidatos = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:ProgramFiles 'Python312\python.exe')
    )
    foreach ($c in $candidatos) { if (Test-Path $c) { return $c } }
    try {
        $p = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $p -and (Test-Path $p)) { return $p.Trim() }
    } catch { }
    return $null
}


Write-Host ''
Write-Host '  Instalador do robô SIAT Automação' -ForegroundColor White
Write-Host "  Pasta do sistema: $Raiz"
Write-Host "  Usuário do Windows: $env:USERDOMAIN\$env:USERNAME"
Write-Host ''
Write-Host '  O robô vai iniciar sozinho sempre que ESTE usuário entrar no Windows.'
if (-not (SimNao 'Continuar?')) { exit 0 }

# ------------------------------------------------------------------------------
Titulo '1/6 Programas necessários'
$PyBase = Achar-Python312
if (-not $PyBase) {
    Aviso 'Python 3.12 não encontrado.'
    if ($PythonInstalador -and (Test-Path -LiteralPath $PythonInstalador)) {
        Write-Host '  Instalando o Python 3.12 (1 a 2 minutos)...'
        Start-Process -FilePath $PythonInstalador -Wait -ArgumentList '/quiet', 'InstallAllUsers=0', 'PrependPath=0', `
            'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Shortcuts=0'
    }
    else {
        if (-not (SimNao 'Instalar o Python 3.12 agora (winget)?')) { Falha 'Instale o Python 3.12 (python.org) e rode de novo.' }
        winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    }
    $PyBase = Achar-Python312
    if (-not $PyBase) { Falha 'O Python foi instalado, mas não foi encontrado. Feche esta janela e rode o instalador de novo.' }
}
Ok "Python: $PyBase"

$Chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) {
    Aviso 'Google Chrome não encontrado.'
    if (-not (SimNao 'Instalar o Google Chrome agora (winget)?')) { Falha 'Instale o Google Chrome e rode de novo.' }
    try { winget install -e --id Google.Chrome --accept-package-agreements --accept-source-agreements } catch { }
    $Chrome = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Chrome) { Falha 'Não foi possível instalar o Google Chrome. Instale-o (google.com/chrome) e rode de novo.' }
    Ok "Google Chrome: $Chrome"
}
else { Ok "Google Chrome: $Chrome" }

# ------------------------------------------------------------------------------
Titulo '2/6 Ambiente do robô (pode levar alguns minutos na primeira vez)'
if (-not (Test-Path $Py)) {
    & $PyBase -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Falha 'Não foi possível criar o ambiente Python (.venv).' }
}
& $Py -m pip install --disable-pip-version-check -q --upgrade pip
& $Py -m pip install --disable-pip-version-check -q -r (Join-Path $Worker 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Falha 'Falha ao instalar as dependências (verifique a internet).' }
Ok 'Dependências instaladas'

# ------------------------------------------------------------------------------
Titulo '3/6 Configuração (.env)'
$novo = -not (Test-Path $EnvFile)
if ($novo -and $Silencioso -and -not $Conexao) { Falha 'Configuração (.env) não encontrada.' }
if ($novo) {
    if (-not (Test-Path $Exemplo)) { Falha ".env.example não encontrado em $Raiz" }
    $linhas = Ler-Env $Exemplo
    if ($Conexao) {
        $dados = @(Get-Content -LiteralPath $Conexao -Encoding UTF8)
        Remove-Item -LiteralPath $Conexao -Force
        $url = $dados[0].Trim().TrimEnd('/')
        $secret = $dados[1].Trim()
    }
    else {
        Write-Host '  Informe os dados do Supabase (Supabase > Project Settings > API Keys).'
        $url = ''
        while ($url -notmatch '^https://[a-z0-9-]+\.supabase\.co/?$') {
            $url = Pergunta 'URL do projeto (https://xxxx.supabase.co)'
        }
        $url = $url.TrimEnd('/')
        $sec = Read-Host '  Secret key (sb_secret_...; não aparece enquanto digita)' -AsSecureString
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    if ($secret -notmatch '^(sb_secret_|eyJ)') { Falha 'A chave informada não parece uma secret key do Supabase.' }
    $anon = if ($Silencioso) { '' } else { Pergunta 'Publishable key (sb_publishable_...; opcional, Enter para pular)' }
    Definir-Env $linhas 'SUPABASE_URL' $url
    Definir-Env $linhas 'NEXT_PUBLIC_SUPABASE_URL' $url
    Definir-Env $linhas 'SUPABASE_SERVICE_ROLE_KEY' $secret
    if ($anon) { Definir-Env $linhas 'SUPABASE_ANON_KEY' $anon; Definir-Env $linhas 'NEXT_PUBLIC_SUPABASE_ANON_KEY' $anon }
    $secret = $null
    # valores de produção (os mesmos usados no computador principal)
    Definir-Env $linhas 'AUTOMATION_DRY_RUN' 'false'
    Definir-Env $linhas 'AUTOMATION_SCREENSHOTS' 'true'
    Definir-Env $linhas 'CHROME_POLICY_MODE' 'per_job'
    Definir-Env $linhas 'CHROME_POLICY_ALLOW_WRITE' 'true'
    Ok 'Chaves registradas (o .env fica só neste computador e nunca vai para o GitHub)'
}
else {
    $linhas = Ler-Env $EnvFile
    Ok ".env já existe; chaves mantidas"
}
if (-not (Valor-Env $linhas 'SECRET_ENCRYPTION_KEY')) {
    Push-Location $Worker; $chave = (& $Py -m app.tools.generate_key); Pop-Location
    Definir-Env $linhas 'SECRET_ENCRYPTION_KEY' $chave.Trim()
}

# pasta de downloads
$atual = Valor-Env $linhas 'DOWNLOAD_BASE_PATH'
Write-Host ''
Write-Host "  Pasta de downloads atual: $(if ($atual) { $atual } else { './storage/downloads' })"
Write-Host '  As notas ficam neste computador até você apagá-las (o robô nunca apaga os ZIPs).'
if (SimNao 'Usar outra pasta de downloads?' $false $false) {
    $outra = Pergunta 'Caminho completo da pasta'
    if ($outra) {
        New-Item -ItemType Directory -Force -Path $outra | Out-Null
        Definir-Env $linhas 'DOWNLOAD_BASE_PATH' $outra
        Ok "Downloads: $outra"
    }
}
Gravar-Env $linhas $EnvFile

# ------------------------------------------------------------------------------
Titulo '4/6 Verificação'
Push-Location $Worker
$env:PYTHONIOENCODING = 'utf-8'
& $Py -m app.tools.check_setup
$verificacao = $LASTEXITCODE
Pop-Location
$script:ComAvisos = ($verificacao -ne 0)
if ($verificacao -ne 0) {
    Aviso 'A verificação encontrou problemas (veja acima). O robô pode ser instalado mesmo assim,'
    Aviso 'mas os clientes com erro vão falhar até a correção.'
    if (-not (SimNao 'Continuar a instalação?' $false $true)) { exit 1 }
}

# ------------------------------------------------------------------------------
Titulo '5/6 Início automático com o Windows'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Servico`"" `
    -WorkingDirectory $Worker
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User $usuario
$gatilho.Delay = 'PT1M'  # espera o Windows terminar de carregar (rede, Chrome)
$principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Highest
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $acao -Trigger $gatilho -Principal $principal -Settings $config `
    -Description 'Robô SIAT Automação: agenda e baixa NFC-e/NF-e.' -Force | Out-Null
Ok "Tarefa '$TaskName' criada: o robô inicia 1 minuto depois que $usuario entra no Windows"

# link siatrobo://abrir/<id>: o botão "Abrir pasta" do painel abre o Explorer com a nota selecionada
$Proto = 'HKCU:\Software\Classes\siatrobo'
$Pyw = Join-Path $Venv 'Scripts\pythonw.exe'
$Abrir = Join-Path $Worker 'abrir_nota.pyw'
New-Item -Path "$Proto\shell\open\command" -Force | Out-Null
Set-Item -Path $Proto -Value 'URL:SIAT Robô'
New-ItemProperty -Path $Proto -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$Icone = Join-Path $PSScriptRoot 'robo.ico'
if (Test-Path $Icone) { New-Item -Path "$Proto\DefaultIcon" -Force | Out-Null; Set-Item -Path "$Proto\DefaultIcon" -Value $Icone }
Set-Item -Path "$Proto\shell\open\command" -Value ('"{0}" "{1}" "%1"' -f $Pyw, $Abrir)
Ok 'Botão "Abrir pasta" do painel ligado a este computador'

# ------------------------------------------------------------------------------
Titulo '6/6 Energia'
Write-Host '  Se o computador entrar em suspensão, o robô para até ele acordar.'
if (SimNao 'Impedir a suspensão automática quando o computador estiver na tomada?' $true ([bool]$SemSuspensao)) {
    powercfg /change standby-timeout-ac 0
    Ok 'Suspensão automática desativada na tomada (a tela ainda pode apagar normalmente)'
}

# ------------------------------------------------------------------------------
Write-Host ''
Write-Host '  Instalação concluída.' -ForegroundColor Green
Write-Host '  Comandos na pasta do sistema:'
Write-Host '    iniciar-robo.bat      liga o robô agora (sem precisar reiniciar o Windows)'
Write-Host '    parar-robo.bat        pede ao robô para terminar o job atual e parar'
Write-Host '    status-robo.bat       mostra se está rodando e as últimas mensagens'
Write-Host '    desinstalar-robo.bat  remove o início automático'
Write-Host ''
if (SimNao 'Ligar o robô agora?' $true ([bool]$Iniciar)) {
    Remove-Item (Join-Path $Raiz 'storage\parar-robo.flag') -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
    Ok 'Robô iniciado em segundo plano. Acompanhe pelo painel (Fila) ou por status-robo.bat.'
    Aviso 'Se a janela antiga do worker (iniciar-worker.bat) estiver aberta, feche-a para não rodar dois robôs.'
}

if ($Silencioso -and $Log) { Stop-Transcript | Out-Null }
# 2 = instalado, mas a verificação encontrou problemas (ex.: certificado não instalado)
if ($script:ComAvisos) { exit 2 }
exit 0
