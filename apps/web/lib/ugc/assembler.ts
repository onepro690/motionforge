// Server-side video assembly for UGC takes
// Reuses fluent-ffmpeg + @ffmpeg-installer/ffmpeg (already in the project)
// Merges multiple Veo3 takes with optional audio narration

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface TakeInfo {
  url: string;
  durationSeconds?: number;
}

export interface AssemblyResult {
  finalVideoUrl: string;
  durationSeconds: number;
}

// Download a file from URL to a temp path
async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  await writeFile(destPath, Buffer.from(buffer));
}

// Concatenate multiple MP4 files using ffmpeg concat demuxer
async function concatVideos(inputPaths: string[], outputPath: string): Promise<void> {
  const listPath = outputPath + ".list.txt";
  const listContent = inputPaths.map((p) => `file '${p}'`).join("\n");
  await writeFile(listPath, listContent, "utf8");

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });

  await unlink(listPath).catch(() => {});
}

// Substitui o áudio do vídeo pela narração. Antes a gente mixava 20% do
// áudio do Veo + 100% da narração, mas isso causava voz dupla — o Veo já
// gera lip-sync com voz própria. Agora trocamos completo pela faixa de TTS.
async function mixAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-shortest",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// Get video duration in seconds
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (_err, data) => {
      resolve(data?.format?.duration ?? 0);
    });
  });
}

// Trim trailing silence from a video.
// Uses ffmpeg silencedetect to find where speech ends, then trims.
// Keeps a small buffer (0.3s) after last speech for natural ending.
async function trimTrailingSilence(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    // Detect silence periods using ffmpeg
    const silenceInfo = await new Promise<string>((resolve) => {
      let stderr = "";
      ffmpeg(inputPath)
        .audioFilters("silencedetect=noise=-30dB:d=0.5")
        .format("null")
        .output("/dev/null")
        .on("stderr", (line: string) => { stderr += line + "\n"; })
        .on("end", () => resolve(stderr))
        .on("error", () => resolve(stderr))
        .run();
    });

    // Parse silence_end timestamps — find the last one
    const silenceEndMatches = [...silenceInfo.matchAll(/silence_end:\s*([\d.]+)/g)];
    const duration = await new Promise<number>((resolve) => {
      ffmpeg.ffprobe(inputPath, (_err, data) => resolve(data?.format?.duration ?? 0));
    });

    if (silenceEndMatches.length === 0 || duration <= 0) {
      // No silence detected or can't get duration — use original
      return false;
    }

    const lastSpeechEnd = parseFloat(silenceEndMatches[silenceEndMatches.length - 1][1]);
    const trimPoint = Math.min(lastSpeechEnd + 0.3, duration); // 0.3s buffer

    // Only trim if there's significant trailing silence (>0.8s)
    if (duration - trimPoint < 0.8) return false;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(trimPoint)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return true;
  } catch (err) {
    console.error("[assembler] trimTrailingSilence error:", err);
    return false;
  }
}

// Main assembly function
export async function assembleTakes(
  takes: TakeInfo[],
  audioUrl: string | null,
  videoId: string
): Promise<AssemblyResult> {
  const id = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `ugc-assembly-${id}`);
  await mkdir(tmpDir, { recursive: true });

  const takePaths: string[] = [];
  const concatPath = join(tmpDir, "concat.mp4");
  const finalPath = join(tmpDir, "final.mp4");
  const audioPath = join(tmpDir, "narration.mp3");

  try {
    // Download all takes
    for (let i = 0; i < takes.length; i++) {
      const takePath = join(tmpDir, `take-${i}.mp4`);
      await downloadFile(takes[i].url, takePath);

      // Trim trailing silence from each take to avoid dead air between takes
      const trimmedPath = join(tmpDir, `take-${i}-trimmed.mp4`);
      const wasTrimmed = await trimTrailingSilence(takePath, trimmedPath);
      if (wasTrimmed) {
        await unlink(takePath).catch(() => {});
        takePaths.push(trimmedPath);
      } else {
        takePaths.push(takePath);
      }
    }

    // Concatenate takes
    await concatVideos(takePaths, concatPath);

    // Mix with audio if available
    if (audioUrl) {
      await downloadFile(audioUrl, audioPath);
      await mixAudio(concatPath, audioPath, finalPath);
    } else {
      // Just use the concatenated video
      await writeFile(finalPath, await readFile(concatPath));
    }

    const durationSeconds = await getVideoDuration(finalPath);
    const videoBuffer = await readFile(finalPath);

    const blob = await put(`ugc-final-${videoId}.mp4`, videoBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    return {
      finalVideoUrl: blob.url,
      durationSeconds,
    };
  } finally {
    // Cleanup temp files
    const allPaths = [...takePaths, concatPath, finalPath, audioPath];
    await Promise.all(allPaths.map((p) => unlink(p).catch(() => {})));
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
}
