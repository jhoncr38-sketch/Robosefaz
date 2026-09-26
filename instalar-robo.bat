@echo off
rem Instala (ou repara) o robo SIAT neste computador: Python, dependencias,
rem .env e inicio automatico junto com o Windows.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Solicitando permissao de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
chcp 65001 >nul
title SIAT Automacao - Instalador
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalador\instalar.ps1"
echo.
pause
