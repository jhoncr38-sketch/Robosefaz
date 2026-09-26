#Requires -Version 5.1
<#
  Mantém o robô rodando em segundo plano (chamado pela tarefa agendada
  "SIAT Automacao - Robo", sem janela, como administrador).

  - Se o worker encerrar por erro, espera e inicia de novo (15 s, 30 s ... até 5 min).
  - parar-robo.bat cria storage\parar-robo.flag: o worker termina o job atual,
    encerra, e este script também para.
  - Mensagens: storage\logs\worker.log (log do robô) e storage\logs\worker-erros.log.
#>
$ErrorActionPreference = 'Continue'

$Raiz   = Split-Path -Parent $PSScriptRoot
$Worker = Join-Path $Raiz 'worker'
$Py     = Join-Path $Worker '.venv\Scripts\python.exe'
$Logs   = Join-Path $Raiz 'storage\logs'
$Flag   = Join-Path $Raiz 'storage\parar-robo.flag'
$Saida  = Join-Path $Logs 'worker-console.log'
$Erros  = Join-Path $Logs 'worker-erros.log'
$Hist   = Join-Path $Logs 'servico.log'

New-Item -ItemType Directory -Force -Path $Logs | Out-Null
function Registrar([string]$t) { Add-Content -LiteralPath $Hist -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $t" -Encoding UTF8 }

# apenas uma cópia do serviço por computador
$mutex = New-Object System.Threading.Mutex($false, 'Global\SiatAutomacaoRoboServico')
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
    if (-not (Test-Path $Py)) { Registrar "ERRO: $Py não encontrado. Rode instalar-robo.bat."; exit 1 }
    Remove-Item -LiteralPath $Flag -ErrorAction SilentlyContinue
    # ícone ao lado do relógio (se já estiver aberto, a nova cópia se fecha sozinha)
    $Pyw = Join-Path $Worker '.venv\Scripts\pythonw.exe'
    if (Test-Path $Pyw) { Start-Process -FilePath $Pyw -ArgumentList '-m', 'app.tray' -WorkingDirectory $Worker }
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUNBUFFERED = '1'
    $falhas = 0
    while ($true) {
        Registrar 'Iniciando worker'
        $inicio = Get-Date
        $p = Start-Process -FilePath $Py -ArgumentList '-m', 'app.worker' -WorkingDirectory $Worker `
            -NoNewWindow -PassThru -Wait -RedirectStandardOutput $Saida -RedirectStandardError $Erros
        Registrar "Worker encerrou (código $($p.ExitCode))"
        if (Test-Path -LiteralPath $Flag) {
            Remove-Item -LiteralPath $Flag -ErrorAction SilentlyContinue
            Registrar 'Parado a pedido (parar-robo.bat)'
            break
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
}
