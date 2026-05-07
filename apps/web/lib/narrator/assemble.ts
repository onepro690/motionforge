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
import { generateCaptionsAss } from "./captions";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

// Combina vídeo (sem áudio) + narração e força a duração da narração.
// Se assPath for fornecido, queima as legendas no vídeo (re-encode necessário).
async function muxNarrationOverVideo(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, assPath?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg().input(videoPath).input(audioPath);

    const outOpts = [
      "-map", "0:v",
      "-map", "1:a",
    ];

    if (assPath) {
      // Burn-in subtitles via filter `subtitles=`. No Linux precisamos escapar
      // o path: substituir `\` por `/`, e escapar `:` (não tem no /tmp). Para
      // segurança usamos POSIX path direto.
      const safe = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      cmd.videoFilter(`subtitles='${safe}'`);
      outOpts.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
    } else {
      outOpts.push("-c:v", "copy");
    }

    outOpts.push(
      "-c:a", "aac",
      "-b:a", "192k",
      "-t", narrationSeconds.toFixed(3),
      "-movflags", "+faststart",
    );

    cmd
      .outputOptions(outOpts)
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

    // Gera arquivo ASS com legendas animadas (Whisper + chunks). Best-effort:
    // se Whisper falhar, segue sem legenda em vez de quebrar o pipeline.
    const captionsOk = await generateCaptionsAss(audioPath, args.narrationSeconds, assPath);

    // Mux narração + corta pra duração exata + queima legendas (se geradas)
    await muxNarrationOverVideo(concatPath, audioPath, args.narrationSeconds, finalPath, captionsOk ? assPath : undefined);

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
