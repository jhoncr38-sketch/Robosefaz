@echo off
rem Gera dist\Instalar-SIAT-Robo-<versao>.exe (precisa do Inno Setup 6 neste computador).
cd /d "%~dp0worker"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m app.tools.build_installer
echo.
pause
