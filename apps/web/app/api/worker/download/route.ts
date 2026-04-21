import { NextResponse } from "next/server";

// Retorna um .bat auto-contido que baixa o worker .mjs do /public e
// inicia o daemon em localhost:3333. Usuário só precisa clicar no arquivo
// baixado (Chrome mostra no canto inferior) — zero navegação no Explorer.

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const mjsUrl = `${origin}/worker/tiktok-verify.mjs`;

  // CRLF é requisito de .bat — Windows rejeita arquivos com LF puro em
  // algumas versões. Escape de literais: % → %% (expansão de variável bat).
  const lines = [
    "@echo off",
    "title MotionForge Live Verify Worker",
    "setlocal",
    "",
    "where node >nul 2>&1",
    "if errorlevel 1 (",
    "  echo.",
    "  echo [ERRO] Node.js nao encontrado.",
    "  echo Baixe e instale Node 18+ em https://nodejs.org",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    `set "SCRIPT=%TEMP%\\motionforge-verify.mjs"`,
    "echo Baixando worker mais recente...",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '${mjsUrl}' -OutFile $env:SCRIPT -UseBasicParsing -TimeoutSec 15; exit 0 } catch { exit 1 }"`,
    "if errorlevel 1 (",
    "  echo.",
    "  echo [ERRO] Falha ao baixar. Verifique sua conexao.",
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "echo.",
    "echo ==========================================================",
    "echo  MotionForge Live Verify Worker rodando em localhost:3333",
    "echo  Volte ao site e clique em 'Buscar Lives ao Vivo'.",
    "echo  Deixe esta janela aberta. Feche com Ctrl+C para parar.",
    "echo ==========================================================",
    "echo.",
    "",
    `node "%SCRIPT%"`,
    "",
    "echo.",
    "echo Daemon parou. Pressione qualquer tecla para fechar.",
    "pause >nul",
    "",
  ];

  const bat = lines.join("\r\n");

  return new NextResponse(bat, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="motionforge-worker.bat"',
      "Cache-Control": "no-store",
    },
  });
}
