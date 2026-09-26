@echo off
chcp 65001 >nul
title SIAT Automacao - Status do robo
echo.
schtasks /Query /TN "SIAT Automacao - Robo" /FO LIST 2>nul | findstr /i /c:"Status" /c:"Estado"
if %errorlevel% neq 0 echo Inicio automatico: NAO instalado (execute instalar-robo.bat)
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
