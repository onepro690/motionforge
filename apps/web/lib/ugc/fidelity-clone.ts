// Fidelity Clone Mode — usa Pixverse Swap via Fal pra trocar a pessoa do
// vídeo de referência pelo avatar do usuário. O modelo opera no vídeo
// nativamente preservando motion, timing e áudio (original_sound_switch=true).
// Produz vídeo com movimento real (não slideshow).
//
// Arquitetura fire-and-forget:
//   - startFidelityClone: submete job pro Fal e salva request_id em
//     currentStep. Marca status=GENERATING_TAKES pra cron assumir.
//   - pollFidelityClone (cron): checa status do Fal. Se COMPLETED, baixa
//     o mp4, rehospeda no Blob e marca AWAITING_REVIEW. Se FAILED, marca
//     FAILED. Se ainda processando, retorna pra tentar de novo no próximo
//     tick do cron (a cada 2min).

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { fetchTikwmDetail } from "./reference-video";

const FAL_QUEUE = "https://queue.fal.run";
// Submit usa o slug completo do modelo; status/result usam só o namespace
// do app (sem o subpath `/swap`) — padrão Fal queue API.
const FAL_SUBMIT_PATH = "fal-ai/pixverse/swap";
const FAL_QUEUE_NAMESPACE = "fal-ai/pixverse";
const FIDELITY_STEP_PREFIX = "fidelity_clone_processing_";
const FIDELITY_MAX_AGE_MS = 30 * 60 * 1000; // 30min — Pixverse típico <5min

interface FalQueueSubmit {
  request_id: string;
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

export function extractFidelityRequestId(currentStep: string | null): string | null {
  if (!currentStep) return null;
  if (!currentStep.startsWith(FIDELITY_STEP_PREFIX)) return null;
  return currentStep.slice(FIDELITY_STEP_PREFIX.length) || null;
}

export function isFidelityClone(video: { transitionMode?: string | null }): boolean {
  return video.transitionMode === "fidelity_clone";
}

async function submitFaceSwapJob(params: {
  imageUrl: string;
  videoUrl: string;
}): Promise<FalQueueSubmit> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY not configured");

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
    throw new Error(`Fal submit failed ${res.status}: ${txt.slice(0, 400)}`);
  }
  return (await res.json()) as FalQueueSubmit;
}

export async function startFidelityClone(videoId: string): Promise<void> {
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

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: {
      status: "SUBMITTING_TAKES",
      currentStep: "fidelity_clone_fetching_reference",
      generationStartedAt: new Date(),
    },
  });

  const reference = [...video.product.detectedVideos]
    .sort((a, b) => Number((b.views ?? 0n) - (a.views ?? 0n)))
    .find((v) => v.videoUrl);
  if (!reference?.videoUrl) throw new Error("Produto sem vídeo de referência com URL do TikTok");

  const detail = await fetchTikwmDetail(reference.videoUrl);
  if (!detail?.playUrl) throw new Error("Falha ao obter mp4 do TikTok via tikwm");

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { currentStep: "fidelity_clone_submitting_fal" },
  });
  const submit = await submitFaceSwapJob({
    imageUrl: video.character.imageUrl,
    videoUrl: detail.playUrl,
  });
  console.log(`[fidelity-clone] fal job submitted: ${submit.request_id}`);

  // Salva duração e request_id. GENERATING_TAKES faz o cron assumir o polling.
  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: {
      status: "GENERATING_TAKES",
      currentStep: `${FIDELITY_STEP_PREFIX}${submit.request_id}`,
      durationSeconds: detail.durationSeconds ?? null,
    },
  });
}

// Chamada pelo cron. Uma iteração: checa status. Se pronto, finaliza. Se
// ainda processando, retorna sem erro. Se timeout/falha, marca FAILED.
export async function pollFidelityClone(videoId: string): Promise<{ status: string }> {
  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      currentStep: true,
      generationStartedAt: true,
    },
  });
  if (!video) throw new Error(`video ${videoId} not found`);

  const requestId = extractFidelityRequestId(video.currentStep);
  if (!requestId) {
    throw new Error(`video ${videoId} não tem request_id em currentStep`);
  }

  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error("FAL_KEY not configured");

  // Timeout absoluto — se passou do MAX_AGE, aborta.
  const started = video.generationStartedAt?.getTime() ?? Date.now();
  if (Date.now() - started > FIDELITY_MAX_AGE_MS) {
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: {
        status: "FAILED",
        errorMessage: `Fidelity clone timeout — Fal job ${requestId} não concluiu em ${FIDELITY_MAX_AGE_MS / 60000}min`,
      },
    });
    return { status: "FAILED" };
  }

  const statusUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${requestId}/status`;
  const statusRes = await fetch(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!statusRes.ok) {
    console.warn(`[fidelity-clone] poll status ${statusRes.status} — retry no próximo tick`);
    return { status: "PENDING" };
  }
  const status = (await statusRes.json()) as FalStatus;
  console.log(`[fidelity-clone] ${videoId} fal=${requestId} status=${status.status}`);

  if (status.status === "FAILED") {
    const logs = (status.logs ?? []).map((l) => l.message).join(" | ");
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "FAILED", errorMessage: `Fal job failed: ${logs || "no logs"}` },
    });
    return { status: "FAILED" };
  }

  if (status.status !== "COMPLETED") {
    return { status: status.status };
  }

  // COMPLETED — baixa o resultado e rehospeda
  const resultUrl = `${FAL_QUEUE}/${FAL_QUEUE_NAMESPACE}/requests/${requestId}`;
  const r = await fetch(resultUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Fal result fetch failed: ${r.status}`);
  const result = (await r.json()) as FalVideoResult;
  const falOutputUrl = result.video?.url ?? result.file?.url ?? result.output?.url;
  if (!falOutputUrl) {
    throw new Error(`Fal completed but no video URL: ${JSON.stringify(result).slice(0, 300)}`);
  }

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
      takeCount: 1,
      generationCompletedAt: new Date(),
    },
  });
  console.log(`[fidelity-clone] DONE ${videoId}: ${blob.url}`);
  return { status: "COMPLETED" };
}

// Wrapper mantido pra compatibilidade com pipeline.ts — apenas dispara
// o submit e retorna. Cron cuida do resto.
export async function runFidelityClone(videoId: string): Promise<void> {
  await startFidelityClone(videoId);
}
