@echo off
rem Inicia a API (FastAPI) e o painel web em duas janelas. Nao precisa de administrador.
start "SIAT Automacao - API" /d "%~dp0worker" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
start "SIAT Automacao - Painel" /d "%~dp0apps\web" cmd /k "npm run dev"
echo Painel: http://localhost:3000
timeout /t 5 >nul
