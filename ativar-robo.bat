@echo off
rem Ativa este computador com o codigo gerado no painel (Computadores > Adicionar computador).
chcp 65001 >nul
title SIAT Robo - Ativar este computador
cd /d "%~dp0worker"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m app.tools.activate %*
echo.
pause
