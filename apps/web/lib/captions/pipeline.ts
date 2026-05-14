// Pipeline de legendar vídeo:
//   download → probe (width/height/duration) → extract audio (mp3 mono leve)
//   → Whisper word-level → ASS karaoke → burn-in via libass → upload Blob.
//
// O vídeo não é alterado em nada além da queima da legenda — codec/áudio do
// original são preservados quando possível.

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, unlink, mkdir, rmdir, access } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpegStaticPath from "ffmpeg-static";
import { transcribeWords, groupWordsIntoLines } from "./transcribe";
import { buildKaraokeAss } from "./karaoke-ass";

const execFileP = promisify(execFile);

const FFMPEG_INSTALLER_PATH = ffmpegInstaller.path;
// ffmpeg-static (6.0) — usado quando precisamos de filtros modernos.
const FFMPEG_MODERN_PATH = (ffmpegStaticPath ?? ffmpegInstaller.path) as string;

interface ProbeInfo {
  width: number;
  height: number;
  duration: number;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Download falhou (${res.status}) — ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// Parse stderr do `ffmpeg -i` pra extrair width/height/duration. Não usa
// ffprobe (que não vem no Vercel layer do @ffmpeg-installer).
async function probeVideo(path: string): Promise<ProbeInfo> {
  let stderr = "";
  try {
    // ffmpeg sem output retorna exit code 1 mas escreve toda a metadata no stderr.
    await execFileP(FFMPEG_INSTALLER_PATH, ["-hide_banner", "-i", path], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 20_000,
    });
  } catch (err) {
    const e = err as { stderr?: string };
    stderr = e.stderr ?? "";
  }
  if (!stderr) throw new Error("ffmpeg não retornou metadata");

  // Duration: HH:MM:SS.CC
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  const duration = dm
    ? parseInt(dm[1]) * 3600 + parseInt(dm[2]) * 60 + parseInt(dm[3]) + parseInt(dm[4]) / 100
    : 0;

  // Stream video: ... <W>x<H> ...
  // Pega o primeiro match WxH (resolução do video stream).
  const sm = stderr.match(/Stream #\d+:\d+[^\n]*Video[^\n]*?(\d{2,5})x(\d{2,5})/);
  let width = sm ? parseInt(sm[1]) : 0;
  let height = sm ? parseInt(sm[2]) : 0;

  // Alguns vídeos têm rotation metadata — ffmpeg reporta dim "lógica" via SAR/
  // "DAR" ou linha "rotate: 90". Detecta rotação de 90/270 e troca W/H.
  const rot = stderr.match(/rotate\s*:\s*(\d+)/);
  if (rot) {
    const r = parseInt(rot[1]);
    if (r === 90 || r === 270) {
      [width, height] = [height, width];
    }
  }
  // displaymatrix:rotation rotation -90.00 (formato novo do ffmpeg)
  const dispRot = stderr.match(/displaymatrix:\s*rotation\s*(-?\d+\.\d+)/i);
  if (dispRot) {
    const r = Math.abs(parseFloat(dispRot[1])) % 180;
    if (r > 45) [width, height] = [height, width];
  }

  if (!width || !height) {
    throw new Error(`Não consegui detectar resolução do vídeo. stderr: ${stderr.slice(0, 500)}`);
  }
  return { width, height, duration };
}

// Extrai áudio do vídeo num formato leve que cabe no limite 24MB do Whisper.
// mono, 16kHz, 32kbps mp3 → ~4MB/h de áudio. Whisper aceita facilmente.
async function extractAudio(videoPath: string, outPath: string): Promise<void> {
  const args = [
    "-y", "-hide_banner",
    "-i", videoPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "32k",
    "-f", "mp3",
    outPath,
  ];
  try {
    await execFileP(FFMPEG_INSTALLER_PATH, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`extractAudio falhou: ${e.message}. stderr: ${e.stderr?.slice(-500)}`);
  }
}

// Procura a fonte Anton no bundle. Reusa a embarcada pelo narrator.
async function findFontPath(): Promise<string | null> {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    join(cwd, "apps", "web", "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    "/var/task/apps/web/lib/narrator/fonts/Anton-Regular.ttf",
    "/var/task/lib/narrator/fonts/Anton-Regular.ttf",
  ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch { /* ignore */ }
  }
  return null;
}

let subtitlesSupportCache: boolean | null = null;
async function checkSubtitlesSupport(): Promise<boolean> {
  if (subtitlesSupportCache !== null) return subtitlesSupportCache;
  try {
    const { stdout } = await execFileP(FFMPEG_INSTALLER_PATH, ["-hide_banner", "-filters"], {
      maxBuffer: 5 * 1024 * 1024,
    });
    subtitlesSupportCache = /\bsubtitles\b/i.test(stdout);
  } catch {
    subtitlesSupportCache = false;
  }
  return subtitlesSupportCache;
}

// Queima as legendas no vídeo via libass (subtitles=). Re-encoda vídeo
// (precisa pra desenhar overlay), copia áudio original sem mexer.
async function burnSubtitles(
  videoPath: string,
  assPath: string,
  outPath: string,
  fontsDir: string | null,
): Promise<void> {
  const safeAss = assPath.replace(/\\/g, "/");
  const subtitlesFilter = fontsDir
    ? `subtitles=${safeAss}:fontsdir=${fontsDir.replace(/\\/g, "/")}`
    : `subtitles=${safeAss}`;
  const args = [
    "-y", "-hide_banner",
    "-i", videoPath,
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
  try {
    const { stderr } = await execFileP(FFMPEG_INSTALLER_PATH, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 280_000,
    });
    const tail = stderr.split("\n").slice(-4).join("\n");
    console.log("[captions/pipeline] burn done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[captions/pipeline] burn FAILED:", e.message);
    console.error("[captions/pipeline] stderr:", e.stderr?.slice(-2000));
    throw err;
  }
}

// Fallback quando libass não está disponível ou falhar: mesmo filtro mas via
// ffmpeg-static (6.0) que costuma ter libass built-in.
async function burnSubtitlesModern(
  videoPath: string,
  assPath: string,
  outPath: string,
  fontsDir: string | null,
): Promise<void> {
  const safeAss = assPath.replace(/\\/g, "/");
  const subtitlesFilter = fontsDir
    ? `subtitles=${safeAss}:fontsdir=${fontsDir.replace(/\\/g, "/")}`
    : `subtitles=${safeAss}`;
  const args = [
    "-y", "-hide_banner",
    "-i", videoPath,
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
  try {
    const { stderr } = await execFileP(FFMPEG_MODERN_PATH, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 280_000,
    });
    const tail = stderr.split("\n").slice(-4).join("\n");
    console.log("[captions/pipeline] burn (modern) done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[captions/pipeline] burn (modern) FAILED:", e.message);
    console.error("[captions/pipeline] stderr:", e.stderr?.slice(-2000));
    throw err;
  }
}

export interface CaptionsPipelineArgs {
  videoUrl: string;
  jobId: string;
  // Posição vertical do centro da legenda, % da altura do vídeo (0=topo, 100=base).
  position?: number;
}

export interface CaptionsPipelineResult {
  outputVideoUrl: string;
  language: string | null;
  wordsCount: number;
  linesCount: number;
  durationSeconds: number;
}

export async function runCaptionsPipeline(args: CaptionsPipelineArgs): Promise<CaptionsPipelineResult> {
  const runId = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `captions-${runId}`);
  await mkdir(tmpDir, { recursive: true });

  const inPath  = join(tmpDir, "input.mp4");
  const audioPath = join(tmpDir, "audio.mp3");
  const assPath = join(tmpDir, "captions.ass");
  const outPath = join(tmpDir, "output.mp4");

  try {
    console.log(`[captions/pipeline] start job=${args.jobId} url=${args.videoUrl.slice(0, 80)}...`);

    await downloadToFile(args.videoUrl, inPath);

    const probe = await probeVideo(inPath);
    console.log(`[captions/pipeline] probe: ${probe.width}x${probe.height} dur=${probe.duration.toFixed(1)}s`);

    await extractAudio(inPath, audioPath);

    const transcript = await transcribeWords(audioPath);
    if (!transcript || transcript.words.length === 0) {
      throw new Error("Whisper não retornou palavras — o vídeo tem áudio com fala audível?");
    }
    console.log(`[captions/pipeline] whisper: language=${transcript.language} words=${transcript.words.length}`);

    const lines = groupWordsIntoLines(transcript.words);
    if (lines.length === 0) throw new Error("Nenhuma linha de legenda gerada");
    console.log(`[captions/pipeline] grouped into ${lines.length} lines`);

    const ass = buildKaraokeAss(lines, {
      videoWidth: probe.width,
      videoHeight: probe.height,
      position: args.position,
    });
    await writeFile(assPath, ass, "utf8");

    const fontPath = await findFontPath();
    const fontsDir = fontPath
      ? fontPath.substring(0, fontPath.lastIndexOf("/") >= 0 ? fontPath.lastIndexOf("/") : fontPath.lastIndexOf("\\"))
      : null;
    console.log(`[captions/pipeline] font=${fontPath ?? "system default"}`);

    const hasSubtitles = await checkSubtitlesSupport();
    let burned = false;
    if (hasSubtitles) {
      try {
        await burnSubtitles(inPath, assPath, outPath, fontsDir);
        burned = true;
      } catch (err) {
        console.warn("[captions/pipeline] installer ffmpeg burn falhou, tentando ffmpeg-static:", err);
      }
    }
    if (!burned) {
      await burnSubtitlesModern(inPath, assPath, outPath, fontsDir);
    }

    const buffer = await readFile(outPath);
    const blob = await put(`captions-${args.jobId}.mp4`, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return {
      outputVideoUrl: blob.url,
      language: transcript.language,
      wordsCount: transcript.words.length,
      linesCount: lines.length,
      durationSeconds: probe.duration,
    };
  } finally {
    await Promise.all(
      [inPath, audioPath, assPath, outPath].map((p) => unlink(p).catch(() => {})),
    );
    await rmdir(tmpDir).catch(() => {});
  }
}
