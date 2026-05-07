// Narrator assembly: concatena os N takes do Veo (já com áudio removido), corta
// pra duração exata da narração e troca a faixa de áudio pelo MP3 do TTS.
//
// Importante: cada take Veo tem 8s; depois de N takes, vídeo total = N*8s.
// A narração TTS pode ter qualquer duração ≤ N*7.5s (deixamos buffer no plan),
// então cortamos o vídeo final exatamente na duração do TTS.

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
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

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Concat com re-encode (necessário porque os takes podem vir do Veo com
// timestamps/parâmetros levemente diferentes — concat demuxer falharia).
async function concatVideoOnly(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length === 1) {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPaths[0])
        .outputOptions(["-an", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return;
  }

  const videoLabels = inputPaths.map((_, i) => `[${i}:v]`).join("");
  const filter = `${videoLabels}concat=n=${inputPaths.length}:v=1:a=0[vout]`;

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg();
    for (const p of inputPaths) cmd.input(p);
    cmd
      .complexFilter(filter)
      .outputOptions([
        "-map", "[vout]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-an",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// Procura uma fonte TTF utilizável no sistema (Linux serverless tem algumas
// instaladas). Retorna o primeiro path existente, ou null pra usar default.
async function findUsableFont(): Promise<string | null> {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  const { access } = await import("fs/promises");
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch { /* ignora */ }
  }
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
async function muxWithSubtitles(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, assPath: string): Promise<void> {
  // Path POSIX: no Linux do Vercel não há `:`; só normalizamos backslashes.
  const safeAssPath = assPath.replace(/\\/g, "/");
  const args = [
    "-y",
    "-hide_banner",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", `subtitles=${safeAssPath}`,
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
  takeUrls: string[];           // URLs dos N takes Veo (ordem)
  narrationAudioUrl: string;    // URL do MP3 do TTS
  narrationSeconds: number;     // duração da narração
  jobId: string;                // pra nomear o blob
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

    await downloadToFile(args.narrationAudioUrl, audioPath);

    // Concatena vídeos (sem áudio — takes já vêm sem áudio do strip)
    await concatVideoOnly(takePaths, concatPath);

    // Gera ASS + chunks (whisper). Se Whisper falhar, segue sem legenda.
    const captionsResult = await generateCaptionsAss(audioPath, args.narrationSeconds, assPath);
    console.log(`[narrator/assemble] captions: words=${captionsResult.wordsCount} chunks=${captionsResult.chunks.length} assOk=${captionsResult.assWritten}`);

    let captionsBurned = false;
    if (captionsResult.assWritten) {
      // Tenta primeiro libass (mais bonito)
      const hasSubtitles = await checkSubtitlesSupport();
      if (hasSubtitles) {
        try {
          await muxWithSubtitles(concatPath, audioPath, args.narrationSeconds, finalPath, assPath);
          captionsBurned = true;
        } catch (err) {
          console.error("[narrator/assemble] subtitles failed, will try drawtext:", err);
        }
      }
    }

    // Fallback: drawtext (sem libass)
    if (!captionsBurned && captionsResult.chunks.length > 0) {
      try {
        const fontPath = await findUsableFont();
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
