// Splitter client-side: corta um vídeo em pedaços de ~N segundos usando
// ffmpeg.wasm. Monta o File via WORKERFS (sem copiar pra memória) e usa
// -ss/-t per chunk pra não encher o MEMFS com todos os chunks de uma vez.
//
// Uso:
//   const chunks = await splitVideo(file, { chunkSeconds: 60, onProgress });
//
// Cada chunk retornado é um { index, blob } pronto pra subir no Blob.

import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";

export interface SplitChunk {
  index: number;
  blob: Blob;
  startSeconds: number;
  durationSeconds: number;
}

export interface SplitOptions {
  chunkSeconds: number;
  onProgress?: (phase: string, current: number, total: number) => void;
  onChunk?: (chunk: SplitChunk) => Promise<void> | void;
}

let cachedFFmpeg: FFmpeg | null = null;

async function loadFFmpeg(): Promise<FFmpeg> {
  if (cachedFFmpeg) return cachedFFmpeg;
  const ff = new FFmpeg();
  await ff.load({
    coreURL: "/ffmpeg/ffmpeg-core.js",
    wasmURL: "/ffmpeg/ffmpeg-core.wasm",
  });
  cachedFFmpeg = ff;
  return ff;
}

// Descobre a duração do vídeo criando um <video> temporário.
export function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("não foi possível ler a duração do vídeo"));
    };
    video.src = url;
  });
}

export async function splitVideo(
  file: File,
  opts: SplitOptions,
): Promise<SplitChunk[]> {
  const { chunkSeconds, onProgress, onChunk } = opts;
  const duration = await probeVideoDuration(file);
  const totalChunks = Math.max(1, Math.ceil(duration / chunkSeconds));

  // Caso degenerado: vídeo curto — retorna o arquivo inteiro como 1 chunk.
  if (totalChunks === 1) {
    const chunk: SplitChunk = {
      index: 0,
      blob: file,
      startSeconds: 0,
      durationSeconds: duration,
    };
    if (onChunk) await onChunk(chunk);
    return [chunk];
  }

  onProgress?.("loading_ffmpeg", 0, totalChunks);
  const ff = await loadFFmpeg();

  const MOUNT_POINT = "/input";
  let mounted = false;
  try {
    try { await ff.createDir(MOUNT_POINT); } catch { /* idempotent */ }
    await ff.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_POINT);
    mounted = true;
    const inputPath = `${MOUNT_POINT}/${file.name}`;

    const chunks: SplitChunk[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const startS = i * chunkSeconds;
      const outName = `chunk_${String(i).padStart(4, "0")}.mp4`;
      onProgress?.("splitting", i, totalChunks);

      // -ss antes de -i faz seek rápido por keyframe. -c copy = sem
      // re-encodar (ordem de grandeza mais rápido). Como o Pixverse aceita
      // um pouco de variação de duração e re-encoda internamente, não
      // precisamos forçar keyframe exato.
      const code = await ff.exec([
        "-ss", String(startS),
        "-i", inputPath,
        "-t", String(chunkSeconds),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-y",
        outName,
      ]);
      if (code !== 0) {
        throw new Error(`ffmpeg exitcode ${code} no chunk ${i}`);
      }

      const data = await ff.readFile(outName);
      const bytes = data instanceof Uint8Array
        ? new Uint8Array(data)
        : new TextEncoder().encode(String(data));
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "video/mp4" });
      try { await ff.deleteFile(outName); } catch { /* ignore */ }

      const chunk: SplitChunk = {
        index: i,
        blob,
        startSeconds: startS,
        durationSeconds: Math.min(chunkSeconds, duration - startS),
      };
      chunks.push(chunk);
      if (onChunk) await onChunk(chunk);
    }
    return chunks;
  } finally {
    if (mounted) {
      try { await ff.unmount(MOUNT_POINT); } catch { /* ignore */ }
    }
  }
}
