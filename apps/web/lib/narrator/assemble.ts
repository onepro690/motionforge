// Narrator assembly: concatena os N takes do Veo (já com áudio removido), corta
// pra duração exata da narração e troca a faixa de áudio pelo MP3 do TTS.
//
// Importante: cada take Veo tem 8s; depois de N takes, vídeo total = N*8s.
// A narração TTS pode ter qualquer duração ≤ N*7.5s (deixamos buffer no plan),
// então cortamos o vídeo final exatamente na duração do TTS.

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpegStaticPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir, rmdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";
import { execFile } from "child_process";
import { promisify } from "util";
import { generateCaptionsAss, type DrawtextChunk } from "./captions";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const execFileP = promisify(execFile);

// Binário moderno de ffmpeg (versão 6.0) — necessário pro filtro `xfade` que
// não existe no @ffmpeg-installer (binário de 2018, ffmpeg N-92722). Usado
// só pelo concatTakes; resto da pipeline continua no fluent-ffmpeg padrão.
const FFMPEG_MODERN_PATH = (ffmpegStaticPath ?? ffmpegInstaller.path) as string;

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Força cada take pra 1080x1920 (9:16 vertical exato). Veo às vezes retorna
// vídeos com aspect ratio interno ligeiramente diferente ou com letterbox/
// pillarbox dentro do frame, o que aparece como "vídeo cortado" pro user.
// scale=1080:1920:force_original_aspect_ratio=increase faz upscale mantendo
// proporção até cobrir toda a área, e crop=1080:1920 corta o excedente
// centralizado. Resultado: NUNCA tem barras pretas, sempre vertical full-frame.
const FORCE_VERTICAL_FILTER = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";

// Concat com re-encode (necessário porque os takes podem vir do Veo com
// timestamps/parâmetros levemente diferentes — concat demuxer falharia).
// Cada take passa pelo FORCE_VERTICAL_FILTER antes do concat pra garantir
// que TODOS estão em 1080x1920 puro.
//
// includeAudio=true preserva o áudio dos takes (usado no modo Veo nativo onde
// o lip-sync vem direto do Veo). includeAudio=false descarta áudio (modo
// B-roll/TTS overlay — áudio é a narração que será muxada depois).
// Duração de cada take Veo 3 Fast (sempre 8s).
const TAKE_DURATION_SECS = 8;
// Duração do crossfade entre takes — suaviza snap visual sem comprometer fala.
// 0.25s é curto o suficiente pra ficar imperceptível no áudio quando a quebra
// é em fronteira de pontuação (split por sentence).
const CROSSFADE_SECS = 0.25;
// Filtro de normalização aplicado a cada take ANTES do xfade. fps e
// setpts=PTS-STARTPTS são obrigatórios pra xfade não dar "Invalid argument" —
// streams precisam ter timebase e fps idênticos.
const XFADE_VIDEO_NORMALIZE = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,setpts=PTS-STARTPTS";
const XFADE_AUDIO_NORMALIZE = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB";

// Concat ou crossfade os takes em sequência. Quando N > 1, usa xfade visual
// pra eliminar "snap" entre takes (cada take parte da mesma foto, então sem
// crossfade haveria um corte seco onde o avatar volta pra pose inicial).
//
// includeAudio=true preserva o áudio dos takes (modo Veo nativo) e aplica
// acrossfade pareado pra manter sync com xfade visual. includeAudio=false
// descarta áudio (B-roll / TTS overlay — áudio é narração muxada depois).
async function concatTakes(inputPaths: string[], outputPath: string, includeAudio: boolean): Promise<void> {
  if (inputPaths.length === 1) {
    const opts = includeAudio
      ? ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
      : ["-an", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPaths[0])
        .videoFilter(FORCE_VERTICAL_FILTER)
        .outputOptions(opts)
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return;
  }

  const n = inputPaths.length;
  // Normaliza cada input (fps + sar + setpts) pra xfade não reclamar.
  const vFilters = inputPaths.map((_, i) => `[${i}:v]${XFADE_VIDEO_NORMALIZE}[v${i}]`).join(";");

  // Cadeia de xfade encadeado.
  let xfadeChain = "";
  let prevLabel = "v0";
  let accumulated = TAKE_DURATION_SECS;
  for (let i = 1; i < n; i++) {
    const offset = (accumulated - CROSSFADE_SECS).toFixed(3);
    const outLabel = i === n - 1 ? "vout" : `xv${i}`;
    xfadeChain += `;[${prevLabel}][v${i}]xfade=transition=fade:duration=${CROSSFADE_SECS}:offset=${offset}[${outLabel}]`;
    prevLabel = outLabel;
    accumulated += TAKE_DURATION_SECS - CROSSFADE_SECS;
  }

  let filter = `${vFilters}${xfadeChain}`;
  let mapArgs: string[];
  let codecArgs: string[];

  if (includeAudio) {
    const aPrep = inputPaths.map((_, i) => `[${i}:a]${XFADE_AUDIO_NORMALIZE}[a${i}]`).join(";");
    let acrossfadeChain = "";
    let aPrev = "a0";
    for (let i = 1; i < n; i++) {
      const outLabel = i === n - 1 ? "aout" : `xa${i}`;
      acrossfadeChain += `;[${aPrev}][a${i}]acrossfade=d=${CROSSFADE_SECS}[${outLabel}]`;
      aPrev = outLabel;
    }
    filter = `${vFilters};${aPrep}${xfadeChain}${acrossfadeChain}`;
    mapArgs = ["-map", "[vout]", "-map", "[aout]"];
    codecArgs = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  } else {
    mapArgs = ["-map", "[vout]"];
    codecArgs = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"];
  }

  // CRÍTICO: xfade não existe no @ffmpeg-installer (binário de 2018). Usamos
  // o ffmpeg-static (6.0) via execFile direto pra essa chamada específica.
  const args: string[] = ["-y", "-hide_banner"];
  for (const p of inputPaths) {
    args.push("-i", p);
  }
  args.push("-filter_complex", filter, ...mapArgs, ...codecArgs, outputPath);

  console.log(`[narrator/assemble] ffmpeg-static xfade (${n} takes), filter len=${filter.length}`);
  try {
    const { stderr } = await execFileP(FFMPEG_MODERN_PATH, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 240_000,
    });
    const tail = stderr.split("\n").slice(-5).join("\n");
    console.log("[narrator/assemble] xfade done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[narrator/assemble] xfade FAILED:", e.message);
    console.error("[narrator/assemble] xfade filter:", filter);
    console.error("[narrator/assemble] xfade stderr:", e.stderr?.slice(-3000));
    throw err;
  }
}

// Acha a fonte Anton.ttf que embarcamos em lib/narrator/fonts/. Em prod,
// cwd = /var/task/apps/web e a fonte é incluída via outputFileTracingIncludes.
async function findUsableFont(): Promise<string | null> {
  const { access } = await import("fs/promises");
  const candidates = [
    join(process.cwd(), "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    join(process.cwd(), "apps", "web", "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    "/var/task/apps/web/lib/narrator/fonts/Anton-Regular.ttf",
    "/var/task/lib/narrator/fonts/Anton-Regular.ttf",
    join(process.cwd(), "public", "fonts", "Anton-Regular.ttf"),
    join(process.cwd(), "apps", "web", "public", "fonts", "Anton-Regular.ttf"),
    // fallbacks improváveis em Lambda
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  for (const p of candidates) {
    try {
      await access(p);
      console.log(`[narrator/assemble] using font: ${p}`);
      return p;
    } catch { /* ignora */ }
  }
  console.warn("[narrator/assemble] no font found in any candidate path");
  return null;
}

// Checa se o ffmpeg do installer tem o filtro `subtitles` (libass) disponível.
// Cacheia resultado pra não rodar a cada call.
let subtitlesSupportCache: boolean | null = null;
async function checkSubtitlesSupport(): Promise<boolean> {
  if (subtitlesSupportCache !== null) return subtitlesSupportCache;
  try {
    const { stdout } = await execFileP(ffmpegInstaller.path, ["-hide_banner", "-filters"], {
      maxBuffer: 5 * 1024 * 1024,
    });
    const has = /\bsubtitles\b/i.test(stdout);
    console.log(`[narrator/assemble] subtitles filter support: ${has}`);
    subtitlesSupportCache = has;
    return has;
  } catch (err) {
    console.error("[narrator/assemble] checkSubtitlesSupport error:", err);
    subtitlesSupportCache = false;
    return false;
  }
}

// Mux narração + vídeo + (opcional) burn legendas via libass (subtitles=).
// Roda execFile direto pra capturar stderr quando der erro.
async function muxWithSubtitles(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, assPath: string, fontsDir: string | null): Promise<void> {
  // Path POSIX: no Linux do Vercel não há `:`; só normalizamos backslashes.
  const safeAssPath = assPath.replace(/\\/g, "/");
  const subtitlesFilter = fontsDir
    ? `subtitles=${safeAssPath}:fontsdir=${fontsDir.replace(/\\/g, "/")}`
    : `subtitles=${safeAssPath}`;
  const args = [
    "-y",
    "-hide_banner",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", narrationSeconds.toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ];
  console.log("[narrator/assemble] running ffmpeg with subtitles filter, ass:", safeAssPath);
  try {
    const { stderr } = await execFileP(ffmpegInstaller.path, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 240_000,
    });
    // ffmpeg sempre escreve no stderr — só é erro se exit != 0 (lança throw)
    const tail = stderr.split("\n").slice(-6).join("\n");
    console.log("[narrator/assemble] ffmpeg subtitles done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[narrator/assemble] ffmpeg subtitles FAILED:", e.message);
    console.error("[narrator/assemble] ffmpeg stderr:", e.stderr?.slice(-3000));
    throw err;
  }
}

// Mux com drawtext (fallback se libass não disponível). Cada chunk vira um
// drawtext com `enable='between(t,start,end)'` e leve fade via alpha expr.
async function muxWithDrawtext(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, chunks: DrawtextChunk[], fontPath: string | null): Promise<void> {
  // Constrói filter graph com N drawtext encadeados
  const filters = chunks.map((c, i) => {
    const safeText = c.text
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "’")  // troca apóstrofo por aspa unicode pra evitar bagunça
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .toUpperCase();
    const startMs = (c.start * 1000).toFixed(0);
    const endMs = (c.end * 1000).toFixed(0);
    const popDur = Math.min(180, Math.max(80, (c.end - c.start) * 1000 * 0.3));
    // alpha: fade in nos primeiros 100ms, fade out nos últimos 80ms
    const alphaExpr = `if(lt(t,${c.start}),0,if(lt(t,${c.start}+0.1),(t-${c.start})/0.1,if(gt(t,${c.end}-0.08),max(0,(${c.end}-t)/0.08),1)))`;
    // fontsize varia: cresce 18% nos primeiros popDur ms e estabiliza
    const baseSize = i % 4 === 1 ? 130 : 120;
    const colorByIdx = ["white", "0xFFD700", "white", "0xFFC857"];
    const color = colorByIdx[i % colorByIdx.length];
    const fontfileArg = fontPath ? `:fontfile='${fontPath.replace(/\\/g, "/")}'` : "";
    return `drawtext=text='${safeText}'${fontfileArg}:fontsize=${baseSize}:fontcolor=${color}:bordercolor=black:borderw=8:shadowcolor=black@0.7:shadowx=2:shadowy=4:x=(w-text_w)/2:y=h*0.66:alpha='${alphaExpr}':enable='between(t,${c.start},${c.end})'`;
  }).join(",");

  const args = [
    "-y",
    "-hide_banner",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", filters,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", narrationSeconds.toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ];

  console.log(`[narrator/assemble] running ffmpeg with drawtext (${chunks.length} chunks, font=${fontPath ?? "default"})`);
  try {
    const { stderr } = await execFileP(ffmpegInstaller.path, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 240_000,
    });
    const tail = stderr.split("\n").slice(-6).join("\n");
    console.log("[narrator/assemble] drawtext done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[narrator/assemble] drawtext FAILED:", e.message);
    console.error("[narrator/assemble] drawtext stderr:", e.stderr?.slice(-3000));
    throw err;
  }
}

// Mux sem legendas (fallback final): copia vídeo, troca áudio.
async function muxNoCaptions(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", narrationSeconds.toFixed(3),
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

export interface AssembleNarratorArgs {
  takeUrls: string[];                   // URLs dos N takes Veo (ordem)
  narrationAudioUrl: string | null;     // URL do MP3 do TTS (null no modo Veo nativo)
  narrationSeconds: number;             // duração estimada/real da narração
  jobId: string;                        // pra nomear o blob
  audioMode: "veo_native" | "tts_overlay";
}

export interface AssembleNarratorResult {
  finalVideoUrl: string;
  durationSeconds: number;
}

export async function assembleNarratorVideo(args: AssembleNarratorArgs): Promise<AssembleNarratorResult> {
  const id = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `narrator-${id}`);
  await mkdir(tmpDir, { recursive: true });

  const takePaths: string[] = [];
  const concatPath = join(tmpDir, "concat.mp4");
  const audioPath  = join(tmpDir, "narration.mp3");
  const assPath    = join(tmpDir, "captions.ass");
  const finalPath  = join(tmpDir, "final.mp4");

  try {
    // Download takes em paralelo
    await Promise.all(
      args.takeUrls.map(async (url, i) => {
        const p = join(tmpDir, `take-${i}.mp4`);
        await downloadToFile(url, p);
        takePaths[i] = p;
      })
    );

    // ───────── Modo Veo nativo ─────────
    // Áudio (fala + lip-sync) vem direto dos takes. Concat preservando áudio,
    // sem TTS overlay, sem captions. Duração final = soma dos takes.
    if (args.audioMode === "veo_native") {
      await concatTakes(takePaths, finalPath, true);
      const buffer = await readFile(finalPath);
      const blob = await put(`narrator-${args.jobId}.mp4`, buffer, {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      const actualDuration = await ffmpegProbeDuration(finalPath);
      return {
        finalVideoUrl: blob.url,
        durationSeconds: actualDuration > 0 ? actualDuration : takePaths.length * 8,
      };
    }

    // ───────── Modo TTS overlay (B-roll OU avatar mudo) ─────────
    if (!args.narrationAudioUrl) {
      throw new Error("narrationAudioUrl é obrigatório no modo tts_overlay");
    }
    await downloadToFile(args.narrationAudioUrl, audioPath);

    // Concatena vídeos (sem áudio — takes já vêm sem áudio do strip)
    await concatTakes(takePaths, concatPath, false);

    // Gera ASS + chunks (whisper). Se Whisper falhar, segue sem legenda.
    const captionsResult = await generateCaptionsAss(audioPath, args.narrationSeconds, assPath);
    console.log(`[narrator/assemble] captions: words=${captionsResult.wordsCount} chunks=${captionsResult.chunks.length} assOk=${captionsResult.assWritten}`);

    const fontPath = await findUsableFont();
    const fontsDir = fontPath ? fontPath.substring(0, fontPath.lastIndexOf("/")) || fontPath.substring(0, fontPath.lastIndexOf("\\")) : null;

    let captionsBurned = false;
    if (captionsResult.assWritten) {
      // Tenta primeiro libass (mais bonito)
      const hasSubtitles = await checkSubtitlesSupport();
      if (hasSubtitles) {
        try {
          await muxWithSubtitles(concatPath, audioPath, args.narrationSeconds, finalPath, assPath, fontsDir);
          captionsBurned = true;
        } catch (err) {
          console.error("[narrator/assemble] subtitles failed, will try drawtext:", err);
        }
      }
    }

    // Fallback: drawtext (sem libass)
    if (!captionsBurned && captionsResult.chunks.length > 0) {
      try {
        await muxWithDrawtext(concatPath, audioPath, args.narrationSeconds, finalPath, captionsResult.chunks, fontPath);
        captionsBurned = true;
      } catch (err) {
        console.error("[narrator/assemble] drawtext failed too, will mux without captions:", err);
      }
    }

    // Fallback final: sem legenda
    if (!captionsBurned) {
      console.warn("[narrator/assemble] burning no captions");
      await muxNoCaptions(concatPath, audioPath, args.narrationSeconds, finalPath);
    }

    const buffer = await readFile(finalPath);
    const blob = await put(`narrator-${args.jobId}.mp4`, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return { finalVideoUrl: blob.url, durationSeconds: args.narrationSeconds };
  } finally {
    const all = [...takePaths, concatPath, audioPath, assPath, finalPath];
    await Promise.all(all.map((p) => unlink(p).catch(() => {})));
    await rmdir(tmpDir).catch(() => {});
  }
}

// Pega duração de um arquivo de áudio/vídeo via ffmpeg (parse stderr)
export function ffmpegProbeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    ffmpeg(filePath)
      .outputOptions(["-f", "null"])
      .output(process.platform === "win32" ? "NUL" : "/dev/null")
      .on("stderr", (line: string) => { stderr += line + "\n"; })
      .on("end", () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (m) {
          resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100);
        } else {
          resolve(0);
        }
      })
      .on("error", () => resolve(0))
      .run();
  });
}
