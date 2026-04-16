# MotionForge - YouTube Download Handler
# Chamado automaticamente pelo protocolo motionforge:// quando voce clica "Ir" no site.
# NAO execute este arquivo diretamente.

param([string]$ProtocolUrl)

$host.UI.RawUI.WindowTitle = "MotionForge - YouTube Download"
$host.UI.RawUI.BackgroundColor = "Black"
Clear-Host

Write-Host ""
Write-Host "  MotionForge - YouTube Downloader" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# Extrai a URL do YouTube do protocolo: motionforge://download?url=<encoded>
try {
    $encoded = $ProtocolUrl -replace "^motionforge://download\?url=", ""
    $youtubeUrl = [System.Uri]::UnescapeDataString($encoded)
} catch {
    Write-Host "  ERRO: URL invalida recebida." -ForegroundColor Red
    Write-Host "  Recebido: $ProtocolUrl" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Pressione qualquer tecla para fechar..." -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Pasta de destino (padrao: Downloads\YouTube)
$downloadFolder = "$env:USERPROFILE\Downloads\YouTube"
New-Item -ItemType Directory -Force -Path $downloadFolder | Out-Null

Write-Host "  URL    : $youtubeUrl" -ForegroundColor White
Write-Host "  Pasta  : $downloadFolder" -ForegroundColor White
Write-Host "  Formato: MP4 com audio, ate 1080p" -ForegroundColor White
Write-Host ""
Write-Host "  Iniciando download..." -ForegroundColor Yellow
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# Executa yt-dlp
try {
    $outputTemplate = Join-Path $downloadFolder "%(title)s.%(ext)s"

    & yt-dlp `
        $youtubeUrl `
        -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" `
        --merge-output-format mp4 `
        --no-playlist `
        --newline `
        -o $outputTemplate

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray
        Write-Host "  Download concluido!" -ForegroundColor Green
        Write-Host "  Salvo em: $downloadFolder" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  ERRO: yt-dlp retornou codigo $LASTEXITCODE" -ForegroundColor Red
    }
} catch {
    Write-Host ""
    if ($_.Exception.Message -like "*yt-dlp*" -or $_.Exception.GetType().Name -eq "CommandNotFoundException") {
        Write-Host "  ERRO: yt-dlp nao encontrado!" -ForegroundColor Red
        Write-Host "  Instale com: pip install yt-dlp" -ForegroundColor Yellow
        Write-Host "  Ou baixe em: https://github.com/yt-dlp/yt-dlp/releases" -ForegroundColor Yellow
    } else {
        Write-Host "  ERRO: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "  Pressione qualquer tecla para fechar..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
