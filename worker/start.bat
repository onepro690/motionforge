@echo off
setlocal
title TikTok Verify Daemon
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale Node 18+ em https://nodejs.org
  pause
  exit /b 1
)

echo Iniciando daemon em http://localhost:3333
echo Deixe esta janela aberta enquanto usar "Buscar Lives".
echo Pressione Ctrl+C para parar.
echo.

node tiktok-verify.mjs

echo.
echo Daemon parou. Pressione qualquer tecla para fechar.
pause >nul
