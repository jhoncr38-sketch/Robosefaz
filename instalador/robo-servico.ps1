#Requires -Version 5.1
<#
  Mantém o robô rodando em segundo plano (chamado pela tarefa agendada
  "SIAT Automacao - Robo", sem janela, como administrador).

  - Ao ligar, ANTES do robô pegar trabalho: instala a versão nova, se houver
    (python -m app.updater confere o SHA-256 do instalador).
  - O robô ocioso com versão nova (ou "Atualizar agora" no ícone) cria
    storage\atualizar.flag e encerra; este script atualiza e religa.
  - Se o worker encerrar por erro, espera e inicia de novo (15 s, 30 s ... até 5 min).
  - parar-robo.bat cria storage\parar-robo.flag: o worker termina o job atual,
    encerra, e este script também para.
  - Mensagens: storage\logs\worker.log, worker-erros.log, servico.log e atualizacao.log.
#>
$ErrorActionPreference = 'Continue'

$Raiz    = Split-Path -Parent $PSScriptRoot
$Worker  = Join-Path $Raiz 'worker'
$Py      = Join-Path $Worker '.venv\Scripts\python.exe'
$Pyw     = Join-Path $Worker '.venv\Scripts\pythonw.exe'
$Logs    = Join-Path $Raiz 'storage\logs'
$Flag    = Join-Path $Raiz 'storage\parar-robo.flag'
$UpdFlag = Join-Path $Raiz 'storage\atualizar.flag'
$Pending = Join-Path $Raiz 'storage\updates\pendente.json'
$Saida   = Join-Path $Logs 'worker-console.log'
$Erros   = Join-Path $Logs 'worker-erros.log'
$Hist    = Join-Path $Logs 'servico.log'

New-Item -ItemType Directory -Force -Path $Logs | Out-Null
function Registrar([string]$t) { Add-Content -LiteralPath $Hist -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $t" -Encoding UTF8 }

function Invoke-Atualizacao {
    # $true quando uma versão nova foi instalada
    $p = Start-Process -FilePath $Py -ArgumentList '-m', 'app.updater', '--download' -WorkingDirectory $Worker `
        -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput (Join-Path $Logs 'atualizacao.log') -RedirectStandardError (Join-Path $Logs 'atualizacao-erros.log')
    if ($p.ExitCode -ne 10 -or -not (Test-Path -LiteralPath $Pending)) { return $false }
    $info = Get-Content -LiteralPath $Pending -Raw -Encoding UTF8 | ConvertFrom-Json
    Remove-Item -LiteralPath $Pending -ErrorAction SilentlyContinue
    Registrar "Instalando a versão $($info.version)"
    $setup = Start-Process -FilePath $info.path -PassThru -Wait -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/FROMUPDATER=1',
        "/LOG=`"$(Join-Path $Logs 'atualizacao-setup.log')`""
    )
    Registrar "Instalador da versão $($info.version) terminou (código $($setup.ExitCode))"
    return ($setup.ExitCode -eq 0)
}

function Reiniciar-Servico {
    # recomeça com o script novo (a versão instalada pode ter trocado este arquivo)
    Registrar 'Religando o serviço com a versão nova'
    $script:religar = $true
}

# apenas uma cópia do serviço por computador
$mutex = New-Object System.Threading.Mutex($false, 'Global\SiatAutomacaoRoboServico')
if (-not $mutex.WaitOne(0)) { exit 0 }
$script:religar = $false

try {
    if (-not (Test-Path $Py)) { Registrar "ERRO: $Py não encontrado. Rode o instalador."; exit 1 }
    Remove-Item -LiteralPath $Flag, $UpdFlag -ErrorAction SilentlyContinue
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUNBUFFERED = '1'

    # 1) ao ligar: atualiza antes de qualquer trabalho
    if (Invoke-Atualizacao) { Reiniciar-Servico; return }

    # ícone ao lado do relógio (se já estiver aberto, a nova cópia se fecha sozinha)
    if (Test-Path $Pyw) { Start-Process -FilePath $Pyw -ArgumentList '-m', 'app.tray' -WorkingDirectory $Worker }

    $falhas = 0
    while ($true) {
        Registrar 'Iniciando worker'
        $inicio = Get-Date
        $p = Start-Process -FilePath $Py -ArgumentList '-m', 'app.worker' -WorkingDirectory $Worker `
            -NoNewWindow -PassThru -Wait -RedirectStandardOutput $Saida -RedirectStandardError $Erros
        Registrar "Worker encerrou (código $($p.ExitCode))"
        if (Test-Path -LiteralPath $Flag) {
            Remove-Item -LiteralPath $Flag, $UpdFlag -ErrorAction SilentlyContinue
            Registrar 'Parado a pedido (parar-robo.bat)'
            break
        }
        # 2) robô parou para atualizar (ocioso com versão nova ou "Atualizar agora")
        if (Test-Path -LiteralPath $UpdFlag) {
            Remove-Item -LiteralPath $UpdFlag -ErrorAction SilentlyContinue
            if (Invoke-Atualizacao) { Reiniciar-Servico; return }
            Registrar 'Nenhuma atualização instalada; religando o robô'
            continue
        }
        $durou = ((Get-Date) - $inicio).TotalMinutes
        if ($durou -lt 2) { $falhas++ } else { $falhas = 1 }
        $espera = [Math]::Min(300, 15 * $falhas)
        Registrar "Nova tentativa em $espera s"
        Start-Sleep -Seconds $espera
        if (Test-Path -LiteralPath $Flag) {
            Remove-Item -LiteralPath $Flag -ErrorAction SilentlyContinue
            Registrar 'Parado a pedido (parar-robo.bat)'
            break
        }
    }
}
finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    if ($script:religar) {
        Remove-Item -LiteralPath $Flag -ErrorAction SilentlyContinue  # o instalador deixa o sinal de parada
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`""
        )
    }
}
