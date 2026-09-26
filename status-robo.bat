@echo off
chcp 65001 >nul
title SIAT Automacao - Status do robo
echo.
powershell -NoProfile -Command "$f='%~dp0storage\worker-status.json'; try { $s = Get-Content -LiteralPath $f -Raw -ErrorAction Stop | ConvertFrom-Json; $idade = ((Get-Date).ToUniversalTime() - [datetime]::Parse($s.updated_at).ToUniversalTime()).TotalSeconds; if ($idade -lt 30 -and $s.status -ne 'stopped') { 'Robo: LIGADO (' + $(if ($s.status -eq 'busy') {'trabalhando no SIAT'} else {'aguardando'}) + ')' } else { 'Robo: PARADO' } } catch { 'Robo: PARADO (sem registro de execucao)' }"
schtasks /Query /TN "SIAT Automacao - Robo" >nul 2>&1
if %errorlevel% neq 0 (echo Inicio automatico: NAO instalado - execute o instalador) else (echo Inicio automatico: instalado)
echo.
echo Ultimas mensagens do robo (storage\logs\worker.log):
echo ------------------------------------------------------------
powershell -NoProfile -Command "if (Test-Path '%~dp0storage\logs\worker.log') { Get-Content -LiteralPath '%~dp0storage\logs\worker.log' -Tail 25 -Encoding UTF8 } else { 'Ainda nao ha log.' }"
echo ------------------------------------------------------------
echo.
set /p RESP=Rodar a verificacao completa (certificados, pasta, Supabase)? [s/N] 
if /i "%RESP%"=="s" (
  cd /d "%~dp0worker"
  set PYTHONIOENCODING=utf-8
  ".venv\Scripts\python.exe" -m app.tools.check_setup
)
echo.
pause
