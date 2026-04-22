// Face swap standalone — troca o rosto do vídeo enviado pelo usuário pela
// foto de um personagem, via Fal Pixverse Swap. Não depende de produto nem
// vídeo de referência do TikTok. Mesmo engine usado em fidelity-clone,
// mas operando sobre FaceSwapJob (tabela própria) em vez de
// UgcGeneratedVideo.
//
// Fire-and-forget: submit marca PROCESSING com falRequestId; cron faz polling.

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";

const FAL_QUEUE = "https://queue.fal.run";
const FAL_SUBMIT_PATH = "fal-ai/pixverse/swap";
const FAL_QUEUE_NAMESPACE = "fal-ai/pixverse";
const MAX_AGE_MS = 30 * 60 * 1000;

interface FalSubmit { request_id: string }
interface FalStatus { status: string; logs?: Array<{ message: string }> }
interface FalResult {
  video?: { url: string };
  file?: { url: string };
  output?: { url: string };
}

async function submitJob(params: { imageUrl: string; videoUrl: string }): Promise<FalSubmit> {
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

export async function startFaceSwap(jobId: string): Promise<void> {
  const job = await prisma.faceSwapJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`face swap job ${jobId} não encontrado`);

  const character = await prisma.ugcCharacter.findUnique({
    where: { id: job.characterId },
  });
  if (!character) throw new Error("personagem não encontrado");

  const submit = await submitJob({
    imageUrl: character.imageUrl,
    videoUrl: job.sourceVideoUrl,
  });

  await prisma.faceSwapJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING", falRequestId: submit.request_id },
  });
  console.log(`[face-swap] submitted ${jobId} fal=${submit.request_id}`);
}

export async function pollFaceSwap(jobId: string): Promise<{ status: string }> {
  const job = await prisma.faceSwapJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`face swap job ${jobId} não encontrado`);
  if (!job.falRequestId) throw new Error(`job ${jobId} sem falRequestId`);

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY não configurado");

  if (Date.now() - job.createdAt.getTime() > MAX_AGE_MS) {
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage: `Timeout — Fal ${job.falRequestId} não concluiu em ${MAX_AGE_MS / 60000}min`,
      },
    });
    return { status: "FAILED" };
  }

  const statusUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${job.falRequestId}/status`;
  const statusRes = await fetch(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!statusRes.ok) {
    console.warn(`[face-swap] poll ${statusRes.status} — retry`);
    return { status: "PENDING" };
  }
  const status = (await statusRes.json()) as FalStatus;
  console.log(`[face-swap] ${jobId} fal=${job.falRequestId} status=${status.status}`);

  if (status.status === "FAILED") {
    const logs = (status.logs ?? []).map((l) => l.message).join(" | ");
    await prisma.faceSwapJob.update({
      where: { id: jobId },
      data: { status: "FAILED", errorMessage: `Fal falhou: ${logs || "sem logs"}` },
    });
    return { status: "FAILED" };
  }

  if (status.status !== "COMPLETED") return { status: status.status };

  const resultUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${job.falRequestId}`;
  const r = await fetch(resultUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Fal result fetch ${r.status}`);
  const result = (await r.json()) as FalResult;
  const falOut = result.video?.url ?? result.file?.url ?? result.output?.url;
  if (!falOut) throw new Error("Fal COMPLETED mas sem URL de vídeo");

  const videoRes = await fetch(falOut, { signal: AbortSignal.timeout(120000) });
  if (!videoRes.ok) throw new Error(`Download do Fal falhou ${videoRes.status}`);
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
  console.log(`[face-swap] DONE ${jobId}: ${blob.url}`);
  return { status: "COMPLETED" };
}
