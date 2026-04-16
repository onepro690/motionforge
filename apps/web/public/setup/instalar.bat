@echo off
title MotionForge - Instalador
color 0B
chcp 65001 >nul

echo.
echo   MotionForge - Instalador do YouTube Downloader
echo   ================================================
echo.
echo   Isso so precisa ser feito UMA VEZ.
echo.

set "FOLDER=%APPDATA%\MotionForge"
set "HANDLER=%FOLDER%\yt-handler.ps1"
set "SCRIPT_URL=https://motion-transfer-saas.vercel.app/setup/yt-handler.ps1"

echo   [1/3] Criando pasta de instalacao...
mkdir "%FOLDER%" 2>nul

echo   [2/3] Baixando componentes...
powershell -Command "Invoke-WebRequest -Uri '%SCRIPT_URL%' -OutFile '%HANDLER%' -UseBasicParsing" 2>nul

if not exist "%HANDLER%" (
    echo.
    echo   ERRO: Nao foi possivel baixar os componentes.
    echo   Verifique sua conexao e tente novamente.
    echo.
    pause
    exit /b 1
)

echo   [3/3] Registrando protocolo no Windows...
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge" /ve /d "URL:MotionForge Protocol" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge" /v "URL Protocol" /d "" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell\open" /f >nul
reg add "HKEY_CURRENT_USER\Software\Classes\motionforge\shell\open\command" /ve /d "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Normal -File \"%HANDLER%\" \"%%1\"" /f >nul

echo.
echo   ================================================
echo   Pronto! Tudo instalado com sucesso.
echo.
echo   - Va ao site e cole o link do YouTube
echo   - Clique em "Ir"
echo   - O terminal abre e baixa automaticamente
echo   - Videos salvos em: %USERPROFILE%\Downloads\YouTube\
echo.
echo   Obs: Na primeira vez, o yt-dlp sera baixado
echo   automaticamente quando voce clicar em "Ir".
echo   ================================================
echo.
pause
