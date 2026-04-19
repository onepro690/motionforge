// Fidelity Clone Mode — copia o vídeo de referência frame-a-frame trocando
// SÓ a identidade do personagem via Nano Banana. Mantém motion, timing,
// lip-sync e áudio original intactos. É o único caminho que cumpre o
// requisito "literalmente copiar o vídeo, mudar só o personagem".
//
// Pipeline:
//   1. Baixa mp4 do TikTok (via tikwm)
//   2. Extrai frames em FPS reduzido + áudio em arquivo separado
//   3. Roda cada frame no Nano Banana (concorrência limitada)
//      com a foto do avatar como identity lock
//   4. Remonta o vídeo com ffmpeg: frames swapped + áudio original
//   5. Sobe no Vercel Blob

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { swapPersonWithAvatar } from "./nano-banana";
import { fetchTikwmDetail } from "./reference-video";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Compromisso entre fidelidade e tempo de execução.
// Frames = FPS × duração. Cada frame ~15-30s no Nano Banana.
// Budget Vercel 300s → limite prático 40-50 frames.
const TARGET_FPS = 4;
const MAX_DURATION_SECONDS = 10;
const CONCURRENCY = 5;

async function downloadBuffer(url: string, timeoutMs = 60000): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractFramesAndAudio(
  videoBuffer: Buffer,
  workDir: string
): Promise<{ frameUrls: string[]; audioPath: string | null; fps: number }> {
  const videoPath = join(workDir, "ref.mp4");
  const framesDir = join(workDir, "frames");
  const audioPath = join(workDir, "audio.m4a");
  await mkdir(framesDir, { recursive: true });
  await writeFile(videoPath, videoBuffer);

  // Extrai frames limitados por -t MAX_DURATION e FPS TARGET_FPS.
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        "-t", String(MAX_DURATION_SECONDS),
        "-vf", `fps=${TARGET_FPS}`,
        "-q:v", "2",
      ])
      .output(join(framesDir, "frame-%04d.jpg"))
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });

  // Extrai áudio (mp4→m4a). Se o vídeo não tiver áudio, marca null.
  let audioOk = false;
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions(["-t", String(MAX_DURATION_SECONDS), "-vn", "-acodec", "aac", "-b:a", "128k"])
        .output(audioPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    const stat = await readFile(audioPath).then((b) => b.byteLength).catch(() => 0);
    audioOk = stat > 100;
  } catch {
    audioOk = false;
  }

  const files = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
  console.log(`[fidelity-clone] extracted ${files.length} frames at ${TARGET_FPS}fps, audio=${audioOk}`);

  // Sobe cada frame no Blob pra Nano Banana conseguir baixar via URL.
  const frameUrls: string[] = [];
  for (const file of files) {
    const buf = await readFile(join(framesDir, file));
    const blob = await put(`fidelity-frame-${randomBytes(4).toString("hex")}-${file}`, buf, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });
    frameUrls.push(blob.url);
  }

  return { frameUrls, audioPath: audioOk ? audioPath : null, fps: TARGET_FPS };
}

async function swapFramesBatch(
  frameUrls: string[],
  avatarUrl: string
): Promise<(string | null)[]> {
  // Primeiro frame: sem previousTakeResult. Serve como âncora.
  // Demais frames: passa o PRIMEIRO swapped como IMAGE 3 — garante mesma
  // identidade em todo o vídeo (Nano Banana trata IMAGE 2 como ground truth
  // mas IMAGE 3 ajuda com estilo/iluminação consistentes).
  const results: (string | null)[] = new Array(frameUrls.length).fill(null);

  // Frame 0 — sequencial, bloqueia o resto.
  const first = await swapPersonWithAvatar(frameUrls[0], avatarUrl, null);
  if (!first) {
    console.error("[fidelity-clone] frame 0 swap failed — aborting");
    return results;
  }
  results[0] = first.url;
  console.log(`[fidelity-clone] frame 0 → ${first.url.substring(0, 60)}`);

  // Restantes em paralelo (em chunks de CONCURRENCY).
  const rest = frameUrls.slice(1);
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const chunk = rest.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (url, idx) => {
        const globalIdx = i + idx + 1;
        try {
          const res = await swapPersonWithAvatar(url, avatarUrl, first.url);
          if (res) console.log(`[fidelity-clone] frame ${globalIdx} ok`);
          else console.warn(`[fidelity-clone] frame ${globalIdx} null result`);
          return res?.url ?? null;
        } catch (err) {
          console.error(`[fidelity-clone] frame ${globalIdx} failed:`, err);
          return null;
        }
      })
    );
    chunkResults.forEach((url, idx) => {
      results[i + idx + 1] = url;
    });
  }

  return results;
}

async function assembleFinalVideo(
  swappedUrls: (string | null)[],
  audioPath: string | null,
  fps: number,
  workDir: string
): Promise<Buffer> {
  const outDir = join(workDir, "swapped");
  await mkdir(outDir, { recursive: true });

  // Baixa cada frame swapped e salva numerado. Se algum falhou (null),
  // reaproveita o último frame bem-sucedido pra não deixar gap.
  let lastGoodBuf: Buffer | null = null;
  for (let i = 0; i < swappedUrls.length; i++) {
    const url = swappedUrls[i];
    let buf: Buffer | null = null;
    if (url) {
      try {
        buf = await downloadBuffer(url, 30000);
      } catch (err) {
        console.warn(`[fidelity-clone] failed to download swapped frame ${i}:`, err);
      }
    }
    if (!buf) buf = lastGoodBuf;
    if (!buf) throw new Error(`no usable frame at index ${i} and no prior fallback`);
    await writeFile(join(outDir, `frame-${String(i).padStart(4, "0")}.jpg`), buf);
    lastGoodBuf = buf;
  }

  const outPath = join(workDir, "final.mp4");

  // Remonta: frames (concat a TARGET_FPS) + áudio original (se houver).
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(join(outDir, "frame-%04d.jpg"))
      .inputOptions(["-framerate", String(fps)]);
    if (audioPath) cmd.input(audioPath);
    cmd
      .outputOptions([
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-r", "30",            // upsample visual pra 30fps (ffmpeg duplica frames)
        "-preset", "veryfast",
        "-crf", "22",
        ...(audioPath ? ["-c:a", "aac", "-b:a", "128k", "-shortest"] : []),
        "-movflags", "+faststart",
      ])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });

  return readFile(outPath);
}

export async function runFidelityClone(videoId: string): Promise<void> {
  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id: videoId },
    include: {
      product: { include: { detectedVideos: true } },
      character: true,
    },
  });
  if (!video) throw new Error(`video ${videoId} not found`);
  if (!video.character?.imageUrl) {
    throw new Error("Fidelity Clone exige um personagem com foto. Selecione um avatar.");
  }

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { status: "BRIEFING", currentStep: "fidelity_clone_starting", generationStartedAt: new Date() },
  });

  // Pega o vídeo de referência com mais views que tenha URL do TikTok.
  const reference = [...video.product.detectedVideos]
    .sort((a, b) => Number((b.views ?? 0n) - (a.views ?? 0n)))
    .find((v) => v.videoUrl);
  if (!reference?.videoUrl) throw new Error("Produto sem vídeo de referência com URL do TikTok");

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { currentStep: "fidelity_clone_fetching_reference" },
  });

  const detail = await fetchTikwmDetail(reference.videoUrl);
  if (!detail?.playUrl) throw new Error("Falha ao obter mp4 do TikTok via tikwm");

  const workId = randomBytes(6).toString("hex");
  const workDir = join("/tmp", `fidelity-${workId}`);
  await mkdir(workDir, { recursive: true });

  try {
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { currentStep: "fidelity_clone_extracting_frames" },
    });
    const refBuf = await downloadBuffer(detail.playUrl);
    const { frameUrls, audioPath, fps } = await extractFramesAndAudio(refBuf, workDir);
    if (frameUrls.length === 0) throw new Error("ffmpeg extraiu 0 frames do vídeo de referência");

    // Evitar status=GENERATING_TAKES: o cron poll-ugc-videos pega vídeos nesse
    // status e roda pollAndAssembleTakes, que tem um bug com takes=[] — marca
    // erradamente como FAILED "Todos os takes falharam". Fidelity clone não
    // cria takes em DB, então usa SUBMITTING_TAKES (não polled) durante swap.
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "SUBMITTING_TAKES", currentStep: `fidelity_clone_swapping_${frameUrls.length}_frames` },
    });
    const swappedUrls = await swapFramesBatch(frameUrls, video.character.imageUrl);
    const successCount = swappedUrls.filter(Boolean).length;
    if (successCount === 0) throw new Error("Nano Banana falhou em todos os frames");
    console.log(`[fidelity-clone] ${successCount}/${frameUrls.length} frames swapped`);

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "ASSEMBLING", currentStep: "fidelity_clone_assembling" },
    });
    const finalBuf = await assembleFinalVideo(swappedUrls, audioPath, fps, workDir);

    const blob = await put(`fidelity-final-${videoId}.mp4`, finalBuf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    // Thumbnail do primeiro frame swapped
    const thumbUrl = swappedUrls.find((u) => u) ?? null;

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: {
        status: "AWAITING_REVIEW",
        currentStep: "done",
        errorMessage: null,
        finalVideoUrl: blob.url,
        thumbnailUrl: thumbUrl,
        durationSeconds: frameUrls.length / fps,
        takeCount: 1,
        generationCompletedAt: new Date(),
      },
    });
    console.log(`[fidelity-clone] DONE: ${blob.url}`);
  } finally {
    // Limpa workdir
    try {
      const files = await readdir(workDir).catch(() => []);
      for (const f of files) {
        const full = join(workDir, f);
        await unlink(full).catch(async () => {
          const sub = await readdir(full).catch(() => []);
          for (const s of sub) await unlink(join(full, s)).catch(() => {});
          await (await import("fs/promises")).rmdir(full).catch(() => {});
        });
      }
      await (await import("fs/promises")).rmdir(workDir).catch(() => {});
    } catch {}
  }
}
