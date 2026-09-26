#Requires -Version 5.1
<#
  Para o robô e o ícone da bandeja (chamado antes de instalar/atualizar e pelo
  desinstalador). NÃO apaga as notas baixadas.

    desinstalar.ps1 [-Raiz <pasta do sistema>] [-RemoverTarefa]
#>
param(
    [string]$Raiz = (Split-Path -Parent $PSScriptRoot),
    [switch]$RemoverTarefa
)
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'SIAT Automacao - Robo'

if (Test-Path -LiteralPath $Raiz) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Raiz 'storage') | Out-Null
    Set-Content -LiteralPath (Join-Path $Raiz 'storage\parar-robo.flag') -Value 'parar'
}
schtasks /End /TN $TaskName 2>$null | Out-Null

# robô (-m app.worker) e ícone (-m app.tray) de qualquer instalação do SIAT Robô
Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -match '-m\s+app\.(worker|tray)\b' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# regra do Chrome que escolhe o certificado: um robô parado à força pode deixar a do último cliente
$chave = 'HKCU:\Software\Policies\Google\Chrome\AutoSelectCertificateForUrls'
if (Test-Path $chave) {
    $item = Get-Item $chave
    foreach ($nome in $item.GetValueNames()) {
        if ([string]$item.GetValue($nome) -match 'sefaz\.pi\.gov\.br') { Remove-ItemProperty -Path $chave -Name $nome }
    }
}

if ($RemoverTarefa) { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null }
Start-Sleep -Seconds 2
exit 0
