@echo off
rem Liga o robo instalado (tarefa "SIAT Automacao - Robo"), em segundo plano.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
if exist "%~dp0storage\parar-robo.flag" del "%~dp0storage\parar-robo.flag"
schtasks /Run /TN "SIAT Automacao - Robo" >nul 2>&1
if %errorlevel% neq 0 (
  echo O robo ainda nao foi instalado neste computador. Execute instalar-robo.bat.
) else (
  echo Robo ligado em segundo plano. Acompanhe pelo painel ou por status-robo.bat.
)
timeout /t 6 >nul
