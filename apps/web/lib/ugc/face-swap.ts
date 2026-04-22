// Face swap com chunking — suporta vídeos longos via pedaços de ~60s.
// Arquitetura:
//   - Cliente (browser) usa ffmpeg.wasm pra splitar o vídeo e sobe cada
//     chunk pro Blob antes de postar o job.
//   - Servidor cria FaceSwapChunk rows, submete cada uma pro Fal Pixverse
//     Swap em paralelo (com cap de concorrência pra respeitar rate limits).
//   - Cron `poll-ugc-videos` checa status de cada chunk; quando todos
//     completam, chama mergeFaceSwap() pra concatenar via ffmpeg.
//   - Vídeo curto (<60s) cai no caso degenerado: 1 chunk = 1 Fal request,
//     merge é no-op (só copia resultUrl do único chunk pro job).

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { spawn } from "child_process";
import { writeFile, mkdir, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const FAL_QUEUE = "https://queue.fal.run";
const FAL_SUBMIT_PATH = "fal-ai/pixverse/swap";
const FAL_QUEUE_NAMESPACE = "fal-ai/pixverse";
const MAX_AGE_MS = 120 * 60 * 1000; // 2h pra jobs longos
const MAX_CONCURRENT_SUBMITS = 5;    // não inundar o Fal de uma vez

interface FalSubmit { request_id: string }
interface FalStatus { status: string; logs?: Array<{ message: string }> }
interface FalResult {
  video?: { url: string };
  file?: { url: string };
  output?: { url: string };
}

async function submitChunkToFal(params: {
  imageUrl: string;
  videoUrl: string;
}): Promise<FalSubmit> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY não configurado");
  const res = await fetch(`${FAL_QUEUE}/${FAL_SUBMIT_PATH}`, {
    method: "POST",
    headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      video_url: params.videoUrl,
      image_url: params.imageUrl,
      mode: "person",
      resolution: "720p",
      original_sound_switch: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Fal submit ${res.status}: ${txt.slice(0, 400)}`);
  }
  return (await res.json()) as FalSubmit;
}

// Inicia N chunks. Concorrência limitada pra evitar rate limit no Fal.
export async function startFaceSwapJob(jobId: string): Promise<void> {
  const job = await prisma.faceSwapJob.findUnique({
    where: { id: jobId },
    include: { chunks: { orderBy: { index: "asc" } } },
  });
  if (!job) throw new Error(`job ${jobId} não encontrado`);

  const character = await prisma.ugcCharacter.findUnique({ where: { id: job.characterId } });
  if (!character) throw new Error("personagem não encontrado");

  const pending = job.chunks.filter((c) => c.status === "QUEUED");
  console.log(`[face-swap] submetendo ${pending.length} chunks (job ${jobId})`);

  for (let i = 0; i < pending.length; i += MAX_CONCURRENT_SUBMITS) {
    const batch = pending.slice(i, i + MAX_CONCURRENT_SUBMITS);
    await Promise.all(
      batch.map(async (chunk) => {
        try {
          const submit = await submitChunkToFal({
            imageUrl: character.imageUrl,
            videoUrl: chunk.sourceUrl,
          });
          await prisma.faceSwapChunk.update({
            where: { id: chunk.id },
            data: { status: "PROCESSING", falRequestId: submit.request_id },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await prisma.faceSwapChunk.update({
            where: { id: chunk.id },
            data: { status: "FAILED", errorMessage: msg.slice(0, 500) },
          });
        }
      }),
    );
  }

  await prisma.faceSwapJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING" },
  });
}

// Iteração única do cron: avança estado de todos chunks PROCESSING do job
// e, se todos completaram, dispara merge.
export async function pollFaceSwapJob(jobId: string): Promise<{ status: string }> {
  const job = await prisma.faceSwapJob.findUnique({
    where: { id: jobId },
    include: { chunks: { orderBy: { index: "asc" } } },
  });
  if (!job) throw new Error(`job ${jobId} não encontrado`);

  // Timeout absoluto — protege contra jobs penderos para sempre.
  if (Date.now() - job.createdAt.getTime() > MAX_AGE_MS) {
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage: `Timeout — job não concluiu em ${MAX_AGE_MS / 60000}min`,
      },
    });
    return { status: "FAILED" };
  }

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY não configurado");

  // Atualiza status dos chunks em PROCESSING — em paralelo com cap de 10
  // pra não estourar timeout em jobs com 90 chunks.
  const POLL_CONCURRENCY = 10;
  const processing = job.chunks.filter((c) => c.status === "PROCESSING" && c.falRequestId);
  for (let i = 0; i < processing.length; i += POLL_CONCURRENCY) {
    const batch = processing.slice(i, i + POLL_CONCURRENCY);
    await Promise.all(batch.map(async (chunk) => {
      try {
        const statusUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${chunk.falRequestId}/status`;
        const statusRes = await fetch(statusUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!statusRes.ok) return;
        const st = (await statusRes.json()) as FalStatus;

        if (st.status === "FAILED") {
          const logs = (st.logs ?? []).map((l) => l.message).join(" | ");
          await prisma.faceSwapChunk.update({
            where: { id: chunk.id },
            data: { status: "FAILED", errorMessage: `Fal falhou: ${(logs || "sem logs").slice(0, 500)}` },
          });
          return;
        }

        if (st.status !== "COMPLETED") return;

        const resultUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${chunk.falRequestId}`;
        const r = await fetch(resultUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) return;
        const result = (await r.json()) as FalResult;
        const falOut = result.video?.url ?? result.file?.url ?? result.output?.url;
        if (!falOut) return;

        await prisma.faceSwapChunk.update({
          where: { id: chunk.id },
          data: { status: "DONE", resultUrl: falOut },
        });
      } catch (err) {
        console.warn(`[face-swap] chunk ${chunk.id} poll error: ${err instanceof Error ? err.message : err}`);
      }
    }));
  }

  // Recarrega pra pegar estado atualizado
  const refreshed = await prisma.faceSwapJob.findUnique({
    where: { id: jobId },
    include: { chunks: true },
  });
  if (!refreshed) throw new Error(`job ${jobId} sumiu`);

  const done = refreshed.chunks.filter((c) => c.status === "DONE").length;
  const failed = refreshed.chunks.filter((c) => c.status === "FAILED").length;
  const total = refreshed.chunks.length;

  await prisma.faceSwapJob.update({
    where: { id: jobId },
    data: { completedChunks: done },
  });

  // Se algum chunk falhou, aborta o job todo.
  if (failed > 0) {
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage: `${failed}/${total} chunks falharam no Fal`,
      },
    });
    return { status: "FAILED" };
  }

  // Se todos completaram, dispara merge (marca MERGING pra não re-disparar).
  if (done === total && refreshed.status === "PROCESSING") {
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: { status: "MERGING" },
    });
    try {
      await mergeFaceSwapJob(jobId);
      return { status: "DONE" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.faceSwapJob.update({
        where: { id: jobId },
        data: { status: "FAILED", errorMessage: `Merge falhou: ${msg.slice(0, 500)}` },
      });
      return { status: "FAILED" };
    }
  }

  return { status: refreshed.status };
}

// Download todos os chunks em ordem, concat via ffmpeg demuxer, upload final.
export async function mergeFaceSwapJob(jobId: string): Promise<void> {
  const job = await prisma.faceSwapJob.findUnique({
    where: { id: jobId },
    include: { chunks: { orderBy: { index: "asc" } } },
  });
  if (!job) throw new Error(`job ${jobId} não encontrado`);
  if (job.chunks.some((c) => !c.resultUrl)) {
    throw new Error("nem todos os chunks têm resultUrl");
  }

  // Caso degenerado: 1 chunk só — não precisa concat.
  if (job.chunks.length === 1) {
    const chunk = job.chunks[0];
    const videoRes = await fetch(chunk.resultUrl!, { signal: AbortSignal.timeout(120000) });
    if (!videoRes.ok) throw new Error(`download falhou: ${videoRes.status}`);
    const buf = Buffer.from(await videoRes.arrayBuffer());
    const blob = await put(`face-swap-${jobId}.mp4`, buf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        resultVideoUrl: blob.url,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
    console.log(`[face-swap] DONE ${jobId} (single chunk): ${blob.url}`);
    return;
  }

  // Múltiplos chunks: baixar todos, concat demuxer, upload.
  const workDir = join(tmpdir(), `face-swap-${jobId}`);
  await mkdir(workDir, { recursive: true });
  try {
    // Downloads paralelos (concorrência 8) — 90 chunks sequenciais seria lento.
    const DL_CONCURRENCY = 8;
    const chunkPaths: string[] = new Array(job.chunks.length);
    for (let i = 0; i < job.chunks.length; i += DL_CONCURRENCY) {
      const batch = job.chunks.slice(i, i + DL_CONCURRENCY);
      await Promise.all(batch.map(async (chunk) => {
        const p = join(workDir, `chunk_${String(chunk.index).padStart(4, "0")}.mp4`);
        const r = await fetch(chunk.resultUrl!, { signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`download chunk ${chunk.index} falhou: ${r.status}`);
        await writeFile(p, Buffer.from(await r.arrayBuffer()));
        chunkPaths[chunk.index] = p;
      }));
    }

    const listPath = join(workDir, "concat.txt");
    await writeFile(
      listPath,
      chunkPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
    );

    const outputPath = join(workDir, "final.mp4");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegInstaller.path, [
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg concat exited ${code}: ${stderr.slice(-500)}`));
      });
      proc.on("error", reject);
    });

    const finalBuf = await readFile(outputPath);
    const blob = await put(`face-swap-${jobId}.mp4`, finalBuf, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        resultVideoUrl: blob.url,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
    console.log(`[face-swap] DONE ${jobId} (${job.chunks.length} chunks merged): ${blob.url}`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
