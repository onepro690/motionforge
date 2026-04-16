@echo off
title MotionForge - Instalador de Protocolo
color 0B

echo.
echo   MotionForge - Instalador do Protocolo YouTube
echo   ================================================
echo.

REM Caminho absoluto do script PowerShell (mesma pasta deste .bat)
set "HANDLER=%~dp0yt-handler.ps1"

REM Verifica se o arquivo existe
if not exist "%HANDLER%" (
    echo   ERRO: yt-handler.ps1 nao encontrado em:
    echo   %HANDLER%
    echo.
    pause
    exit /b 1
)

echo   Registrando protocolo motionforge:// no Windows...
echo.

REM Registra o protocolo no registry do usuario atual
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge" /ve /d "URL:MotionForge Protocol" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge" /v "URL Protocol" /d "" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell\open" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell\open\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Normal -File \"%HANDLER%\" \"%%1\"" /f >nul

echo   Protocolo registrado com sucesso!
echo.
echo   Agora no site motion-transfer-saas.vercel.app:
echo   Cole o link do YouTube e clique "Ir".
echo   O terminal abrira automaticamente e o video sera baixado.
echo.
echo   Videos salvos em: %USERPROFILE%\Downloads\YouTube\
echo.
pause
