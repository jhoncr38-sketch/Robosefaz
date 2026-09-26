#Requires -Version 5.1
<#
  Religa o robô pela tarefa agendada depois de uma atualização automática.

  Chamado por robo-servico.ps1 logo antes de ele encerrar: espera a tarefa
  terminar e a inicia de novo, para o robô continuar rodando DENTRO da tarefa
  (status "Em execução", reinício automático em caso de falha). Se a tarefa não
  existir, inicia o serviço diretamente.
#>
param([string]$Servico)
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'SIAT Automacao - Robo'

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $estado = (schtasks /Query /TN $TaskName /FO CSV /NH 2>$null | ConvertFrom-Csv -Header 'Nome', 'Proxima', 'Status').Status
    if (-not $estado) { break }                      # tarefa não existe
    if ($estado -notmatch 'execu|running') { break } # a instância anterior terminou
}

schtasks /Run /TN $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -ne 0 -and $Servico) {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$Servico`""
    )
}
