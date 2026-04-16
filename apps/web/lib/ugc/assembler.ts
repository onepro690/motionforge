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
      takePaths.push(takePath);
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
