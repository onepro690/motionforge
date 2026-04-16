# MotionForge - YouTube Download Handler
# Executado automaticamente pelo Windows quando voce clica "Ir" no site.

param([string]$ProtocolUrl)

$host.UI.RawUI.WindowTitle = "MotionForge - YouTube Download"
Clear-Host

Write-Host ""
Write-Host "  MotionForge - YouTube Downloader" -ForegroundColor Cyan
Write-Host "  ---------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ── Extrai a URL do YouTube ──────────────────────────────────────────────────
$queryStart = $ProtocolUrl.IndexOf("?url=")
if ($queryStart -lt 0) {
    Write-Host "  ERRO: URL invalida." -ForegroundColor Red
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}
$youtubeUrl = [System.Uri]::UnescapeDataString($ProtocolUrl.Substring($queryStart + 5))

# ── Pasta de trabalho ────────────────────────────────────────────────────────
$motionFolder = "$env:APPDATA\MotionForge"
New-Item -ItemType Directory -Force -Path $motionFolder | Out-Null

$localYtDlp  = "$motionFolder\yt-dlp.exe"
$localFfmpeg = "$motionFolder\ffmpeg.exe"

# curl.exe esta disponivel no Windows 10+ nativamente (muito mais rapido que Invoke-WebRequest)
$curlExe = "$env:SystemRoot\System32\curl.exe"
$useCurl = Test-Path $curlExe

function Download-File($url, $dest, $label) {
    Write-Host "  Baixando $label..." -ForegroundColor Yellow
    if ($useCurl) {
        & $curlExe -L --progress-bar -o $dest $url
    } else {
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($url, $dest)
    }
}

# ── Garante yt-dlp ──────────────────────────────────────────────────────────
if (Get-Command "yt-dlp" -ErrorAction SilentlyContinue) {
    $ytDlp = "yt-dlp"
} elseif (Test-Path $localYtDlp) {
    $ytDlp = $localYtDlp
} else {
    Download-File `
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" `
        $localYtDlp "yt-dlp"
    if (-not (Test-Path $localYtDlp)) {
        Write-Host "  ERRO: Falha ao baixar yt-dlp." -ForegroundColor Red
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown"); exit 1
    }
    $ytDlp = $localYtDlp
    Write-Host "  yt-dlp pronto!" -ForegroundColor Green
}

# ── Garante aria2c (downloader rapido com 16 conexoes paralelas) ─────────────
$localAria2 = "$motionFolder\aria2c.exe"

if (-not (Get-Command "aria2c" -ErrorAction SilentlyContinue) -and -not (Test-Path $localAria2)) {
    Download-File `
        "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip" `
        "$motionFolder\aria2.zip" "aria2c (downloader rapido)"
    if (Test-Path "$motionFolder\aria2.zip") {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip   = [System.IO.Compression.ZipFile]::OpenRead("$motionFolder\aria2.zip")
        $entry = $zip.Entries | Where-Object { $_.Name -eq "aria2c.exe" } | Select-Object -First 1
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $localAria2, $true)
        $zip.Dispose()
        Remove-Item "$motionFolder\aria2.zip" -Force -ErrorAction SilentlyContinue
        Write-Host "  aria2c pronto!" -ForegroundColor Green
    }
}

# ── Garante ffmpeg ───────────────────────────────────────────────────────────
if (Get-Command "ffmpeg" -ErrorAction SilentlyContinue) {
    $ffmpegDir = Split-Path (Get-Command "ffmpeg").Source
} elseif (Test-Path $localFfmpeg) {
    $ffmpegDir = $motionFolder
} else {
    Write-Host "  ffmpeg nao encontrado. Baixando (necessario para 1080p com audio)..." -ForegroundColor Yellow
    Write-Host "  Download unico de ~130MB, nao sera necessario novamente." -ForegroundColor DarkGray
    $ffmpegZip = "$motionFolder\ffmpeg.zip"

    Download-File `
        "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" `
        $ffmpegZip "ffmpeg"

    if (Test-Path $ffmpegZip) {
        Write-Host "  Extraindo ffmpeg..." -ForegroundColor Yellow
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip   = [System.IO.Compression.ZipFile]::OpenRead($ffmpegZip)
        $entry = $zip.Entries | Where-Object { $_.Name -eq "ffmpeg.exe" } | Select-Object -First 1
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $localFfmpeg, $true)
        $zip.Dispose()
        Remove-Item $ffmpegZip -Force -ErrorAction SilentlyContinue
        $ffmpegDir = $motionFolder
        Write-Host "  ffmpeg pronto!" -ForegroundColor Green
    } else {
        Write-Host "  AVISO: ffmpeg nao disponivel. Qualidade maxima sera 720p." -ForegroundColor Yellow
        $ffmpegDir = $null
    }
}

# ── Download do video ────────────────────────────────────────────────────────
$downloadFolder = "$env:USERPROFILE\Downloads\YouTube"
New-Item -ItemType Directory -Force -Path $downloadFolder | Out-Null

Write-Host ""
Write-Host "  URL    : $youtubeUrl" -ForegroundColor White
Write-Host "  Pasta  : $downloadFolder" -ForegroundColor White
Write-Host "  Formato: MP4 com audio, ate 1080p" -ForegroundColor White
Write-Host ""
Write-Host "  Baixando video..." -ForegroundColor Yellow
Write-Host ""

$ytDlpArgs = @(
    $youtubeUrl,
    "-f", "bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--concurrent-fragments", "16",
    "--newline",
    "-o", (Join-Path $downloadFolder "%(title)s.%(ext)s")
)

if ($ffmpegDir) {
    $ytDlpArgs += @("--ffmpeg-location", $ffmpegDir)
}

# aria2c: 16 conexoes por servidor, chunks de 1MB
$aria2Path = if (Get-Command "aria2c" -ErrorAction SilentlyContinue) { "aria2c" }
             elseif (Test-Path $localAria2) { $localAria2 }
             else { $null }

if ($aria2Path) {
    $ytDlpArgs += @(
        "--external-downloader", $aria2Path,
        "--external-downloader-args", "aria2c:-x 16 -k 1M --min-split-size=1M"
    )
}

& $ytDlp @ytDlpArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "  ---------------------------------" -ForegroundColor DarkGray
    Write-Host "  Download concluido!" -ForegroundColor Green
    Write-Host "  Salvo em: $downloadFolder" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  ERRO no download (codigo $LASTEXITCODE)" -ForegroundColor Red
}

Write-Host ""
Write-Host "  Pressione qualquer tecla para fechar..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
