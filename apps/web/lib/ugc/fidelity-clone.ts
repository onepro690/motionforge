// Fidelity Clone Mode — usa Pixverse Swap via Fal pra trocar a pessoa do
// vídeo de referência pelo avatar do usuário. O modelo opera no vídeo
// nativamente preservando motion, timing e áudio (original_sound_switch=true).
// Produz vídeo com movimento real (não slideshow).
//
// Pipeline:
//   1. Pega mp4 do TikTok via tikwm (URL direta sem watermark)
//   2. Submete job pro fal queue: image_url + video_url + mode=person
//   3. Polla até concluir
//   4. Rehospeda no Vercel Blob + update DB

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { fetchTikwmDetail } from "./reference-video";

const FAL_QUEUE = "https://queue.fal.run";
const FAL_MODEL = "fal-ai/pixverse/swap";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 270000; // 4.5min — margem pra 300s maxDuration

interface FalQueueSubmit {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

interface FalStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | string;
  logs?: Array<{ message: string }>;
}

interface FalVideoResult {
  video?: { url: string; file_size?: number; content_type?: string };
  file?: { url: string; file_size?: number; content_type?: string };
  output?: { url: string };
}

async function submitFaceSwapJob(params: {
  imageUrl: string;
  videoUrl: string;
}): Promise<FalQueueSubmit> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY not configured");

  const res = await fetch(`${FAL_QUEUE}/${FAL_MODEL}`, {
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
    throw new Error(`Fal submit failed ${res.status}: ${txt.slice(0, 400)}`);
  }
  return (await res.json()) as FalQueueSubmit;
}

async function pollFalJob(requestId: string): Promise<string> {
  const apiKey = process.env.FAL_KEY!;
  const statusUrl = `${FAL_QUEUE}/${FAL_MODEL}/requests/${requestId}/status`;
  const resultUrl = `${FAL_QUEUE}/${FAL_MODEL}/requests/${requestId}`;

  const start = Date.now();
  while (Date.now() - start < MAX_POLL_MS) {
    const statusRes = await fetch(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!statusRes.ok) {
      console.warn(`[fidelity-clone] poll status ${statusRes.status} — retrying`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const status = (await statusRes.json()) as FalStatus;
    console.log(`[fidelity-clone] fal job ${requestId} status=${status.status}`);

    if (status.status === "COMPLETED") {
      const r = await fetch(resultUrl, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Fal result fetch failed: ${r.status}`);
      const result = (await r.json()) as FalVideoResult;
      const videoUrl = result.video?.url ?? result.file?.url ?? result.output?.url;
      if (!videoUrl) {
        throw new Error(`Fal completed but no video URL in result: ${JSON.stringify(result).slice(0, 300)}`);
      }
      return videoUrl;
    }
    if (status.status === "FAILED") {
      const logs = (status.logs ?? []).map((l) => l.message).join(" | ");
      throw new Error(`Fal job failed: ${logs || "no logs"}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Fal job ${requestId} timed out after ${MAX_POLL_MS / 1000}s`);
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
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY não configurado — fidelity clone requer fal.ai");
  }

  // Cron poll-ugc-videos só pega GENERATING_TAKES, então usamos SUBMITTING_TAKES
  // pra evitar race condition que marca o vídeo como FAILED falsamente.
  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { status: "SUBMITTING_TAKES", currentStep: "fidelity_clone_starting", generationStartedAt: new Date() },
  });

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

  // Submete o job
  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { currentStep: "fidelity_clone_submitting_fal" },
  });
  const submit = await submitFaceSwapJob({
    imageUrl: video.character.imageUrl,
    videoUrl: detail.playUrl,
  });
  console.log(`[fidelity-clone] fal job submitted: ${submit.request_id}`);

  // Poll até concluir
  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { status: "ASSEMBLING", currentStep: `fidelity_clone_processing_${submit.request_id}` },
  });
  const falOutputUrl = await pollFalJob(submit.request_id);
  console.log(`[fidelity-clone] fal output: ${falOutputUrl}`);

  // Rehospeda no Blob pra ter URL persistente (Fal URLs expiram)
  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { currentStep: "fidelity_clone_persisting" },
  });
  const videoRes = await fetch(falOutputUrl, { signal: AbortSignal.timeout(120000) });
  if (!videoRes.ok) throw new Error(`Falha ao baixar video do Fal: ${videoRes.status}`);
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());
  const blob = await put(`fidelity-final-${videoId}.mp4`, videoBuf, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: true,
  });

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: {
      status: "AWAITING_REVIEW",
      currentStep: "done",
      errorMessage: null,
      finalVideoUrl: blob.url,
      durationSeconds: detail.durationSeconds ?? null,
      takeCount: 1,
      generationCompletedAt: new Date(),
    },
  });
  console.log(`[fidelity-clone] DONE: ${blob.url}`);
}
