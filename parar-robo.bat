@echo off
rem Para o robo. Normal: termina o job atual e encerra (o que estiver no SIAT nao fica pela metade).
rem "parar-robo.bat agora": interrompe na hora (o job volta para a fila depois de alguns minutos).
if /i "%~1"=="agora" goto agora
if not exist "%~dp0storage" mkdir "%~dp0storage"
echo parar> "%~dp0storage\parar-robo.flag"
echo Pedido de parada enviado.
echo O robo termina o job atual (se houver) e para. Pode levar alguns minutos.
echo Para ligar de novo: iniciar-robo.bat (ou reinicie o Windows).
timeout /t 8 >nul
exit /b

:agora
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'agora' -Verb RunAs"
  exit /b
)
echo parar> "%~dp0storage\parar-robo.flag"
schtasks /End /TN "SIAT Automacao - Robo" >nul 2>&1
powershell -NoProfile -Command "$v = (Resolve-Path '%~dp0worker\.venv').Path; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.ExecutablePath -like ($v + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Robo interrompido.
timeout /t 5 >nul
