@echo off
setlocal
rem Inicia o worker do SIAT Automacao como administrador.
rem (necessario para aplicar a regra do Chrome que escolhe o certificado)

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Solicitando permissao de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

schtasks /Query /TN "SIAT Automacao - Robo" >nul 2>&1
if %errorlevel% equ 0 (
  echo ATENCAO: o robo automatico esta instalado neste computador.
  echo Use iniciar-robo.bat, parar-robo.bat e status-robo.bat.
  echo Abrir esta janela tambem roda um segundo robo ao mesmo tempo.
  choice /C SN /M "Abrir mesmo assim"
  if errorlevel 2 exit /b
)

cd /d "%~dp0worker"
if not exist ".venv\Scripts\python.exe" (
  echo ERRO: ambiente Python nao encontrado em "%~dp0worker\.venv".
  echo Veja a secao Instalacao do README.md.
  pause
  exit /b 1
)
title SIAT Automacao - Worker
echo Worker do SIAT Automacao. Para encerrar: Ctrl+C (duas vezes interrompe na hora).
echo.
".venv\Scripts\python.exe" -m app.worker
echo.
echo Worker encerrado.
pause
