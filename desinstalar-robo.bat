@echo off
rem Remove o inicio automatico do robo. NAO apaga notas baixadas, .env nem certificados.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo parar> "%~dp0storage\parar-robo.flag"
schtasks /End /TN "SIAT Automacao - Robo" >nul 2>&1
schtasks /Delete /TN "SIAT Automacao - Robo" /F
echo.
echo Inicio automatico removido. Os arquivos continuam na pasta.
echo Para apagar tudo, exclua a pasta do sistema depois de fechar esta janela.
pause
