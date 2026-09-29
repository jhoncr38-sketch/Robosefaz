@echo off
rem Faz o robo salvar as notas numa pasta do Google Drive (menu Iniciar > JR Sistema).
rem Pede permissao de administrador: o robo roda assim e o teste de gravacao precisa valer para ele.
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
title JR Sistema - Salvar notas no Google Drive
cd /d "%~dp0worker"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m app.tools.google_drive %*
echo.
pause
