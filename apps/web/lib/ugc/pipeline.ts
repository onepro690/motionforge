// Main UGC pipeline orchestrator
// Runs each step, logs to DB, handles errors gracefully
// Reuses the Veo3 integration (same Vertex AI code as /api/animate-veo3)

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { GoogleAuth } from "google-auth-library";
import { analyzeCreative, generateBrief, writeCopy, generateVeoPrompts, parseRemakeFeedback, analyzeReferenceScene } from "./llm";
import { pickRandomPersona } from "./personas";
import { generateNarration } from "./tts";
import { assembleTakes } from "./assembler";
import { getAntiRepeatContext, recordUsedElements, getNegativePatterns } from "./anti-repeat";
import { DEFAULT_PROMPT_TEMPLATES } from "./defaults";
import { ensureReferenceTranscript, fetchTikwmDetail, extractKeyFrames } from "./reference-video";
import { swapReferencePerson, imageUrlToBase64 } from "./nano-banana";

const PROJECT_ID = "gen-lang-client-0466084510";
const LOCATION = "us-central1";
const VERTEX_BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;
const VEO3_MODEL_IDS: Record<string, string> = {
  "veo3-fast": "veo-3.0-fast-generate-001",
  "veo3-quality": "veo-3.0-generate-001",
};

// ── Logging helper ─────────────────────────────────────────────────────────

async function log(
  videoId: string,
  step: string,
  status: "started" | "completed" | "failed",
  message?: string,
  data?: unknown,
  durationMs?: number
) {
  await prisma.ugcPipelineLog.create({
    data: { videoId, step, status, message: message ?? null, data: data ? (data as object) : undefined, durationMs: durationMs ?? null },
  }).catch(() => {});
}

async function setStep(videoId: string, step: string) {
  await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { currentStep: step } }).catch(() => {});
}

// ── Vertex AI helpers (reuse same code as animate-veo3/route.ts) ──────────

async function getAccessToken(): Promise<string> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(json) as object;
  const authClient = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await authClient.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to obtain access token");
  return token.token;
}

async function submitVeoTake(
  prompt: string,
  modelId: string,
  accessToken: string,
  image?: { data: string; mimeType: string } | null
): Promise<string> {
  const veoModel = VEO3_MODEL_IDS[modelId] ?? "veo-3.0-fast-generate-001";
  // Image-to-video quando temos a thumbnail editada pelo Nano Banana (mesmo
  // cenário da referência, persona nova). Text-to-video como fallback.
  const instance: Record<string, unknown> = { prompt };
  if (image) {
    instance.image = { bytesBase64Encoded: image.data, mimeType: image.mimeType };
  }
  const res = await fetch(`${VERTEX_BASE}/${veoModel}:predictLongRunning`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      instances: [instance],
      parameters: { aspectRatio: "9:16", durationSeconds: 8, sampleCount: 1 },
    }),
  });
  const data = (await res.json()) as { name?: string; error?: { message: string } };
  if (!res.ok || !data.name) throw new Error(data.error?.message ?? "Veo3 submission failed");
  return data.name;
}

// ── Template helper ────────────────────────────────────────────────────────

async function getTemplate(userId: string, stage: string): Promise<string> {
  const tmpl = await prisma.ugcPromptTemplate.findFirst({
    where: { userId, stage, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  return tmpl?.content ?? DEFAULT_PROMPT_TEMPLATES[stage]?.content ?? "";
}

// ── Main pipeline function ─────────────────────────────────────────────────

export async function runVideoPipeline(
  videoId: string,
  remakeRequest?: { feedback: string; previousVideoId: string }
): Promise<void> {
  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id: videoId },
    include: { product: { include: { detectedVideos: true } } },
  });
  if (!video) throw new Error(`Video ${videoId} not found`);

  const userId = video.userId;
  const product = video.product;

  await prisma.ugcGeneratedVideo.update({
    where: { id: videoId },
    data: { status: "BRIEFING", generationStartedAt: new Date() },
  });

  try {
    // ── Step 1: Get settings + anti-repeat context ──────────────────────────
    await setStep(videoId, "loading_context");
    const [settings, antiRepeat, negativePatterns] = await Promise.all([
      prisma.ugcSystemSettings.findUnique({ where: { userId } }),
      getAntiRepeatContext(userId),
      getNegativePatterns(userId),
    ]);

    const modelId = settings?.defaultModel ?? "veo3-fast";
    const voice = settings?.defaultVoice ?? "nova";
    const maxTakes = Math.min(settings?.maxTakesPerVideo ?? 3, 4);

    // ── Step 2: Analyze creative (or use existing brief) ───────────────────
    const t2 = Date.now();
    await setStep(videoId, "analyzing_creative");
    await log(videoId, "analyze_creative", "started");

    const analysisTemplate = await getTemplate(userId, "creative_analysis");
    const videoDescriptions = product.detectedVideos.map((v) => v.description ?? "").filter(Boolean);

    const analysis = await analyzeCreative(product.name, videoDescriptions, analysisTemplate);
    await log(videoId, "analyze_creative", "completed", undefined, analysis, Date.now() - t2);

    // ── Step 3: Generate creative brief ────────────────────────────────────
    const t3 = Date.now();
    await setStep(videoId, "generating_brief");
    await log(videoId, "generate_brief", "started");

    let remakeInstructions: string | undefined;
    if (remakeRequest) {
      const remakeTemplate = await getTemplate(userId, "remake");
      const prevVideo = await prisma.ugcGeneratedVideo.findUnique({ where: { id: remakeRequest.previousVideoId } });
      const instructions = await parseRemakeFeedback(
        remakeRequest.feedback,
        product.name,
        (prevVideo?.creativeBriefSnapshot as Record<string, string>)?.angle ?? "descoberta",
        prevVideo?.veoPrompts ? "hook anterior" : "hook anterior",
        (prevVideo?.creativeBriefSnapshot as Record<string, string>)?.visualStyle ?? "UGC casual",
        prevVideo?.script ?? "",
        remakeTemplate
      );
      remakeInstructions = JSON.stringify(instructions);
    }

    const briefTemplate = await getTemplate(userId, "creative_brief");
    const brief = await generateBrief(
      product.name,
      { ...analysis, ugcAngles: analysis.ugcAngles.filter((a) => !antiRepeat.recentAngles.includes(a)) },
      antiRepeat.recentAngles,
      briefTemplate
    );
    await log(videoId, "generate_brief", "completed", undefined, brief, Date.now() - t3);

    // Store brief in DB
    const dbBrief = await prisma.ugcCreativeBrief.create({
      data: {
        userId,
        productId: product.id,
        productSummary: analysis.productSummary,
        targetAudience: brief.targetAudience,
        mainProblem: brief.mainProblem,
        desiredOutcome: brief.desiredOutcome,
        angle: brief.angle,
        tone: brief.tone,
        videoStructure: brief.videoStructure,
        suggestedHooks: brief.suggestedHooks,
        suggestedCtas: brief.suggestedCtas,
        videoStyles: brief.visualStyle ? [brief.visualStyle] : [],
      },
    });

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { briefId: dbBrief.id, creativeBriefSnapshot: brief as object },
    });

    // ── Step 4: Write copy ─────────────────────────────────────────────────
    const t4 = Date.now();
    await setStep(videoId, "writing_copy");
    await log(videoId, "write_copy", "started");

    const copyTemplate = await getTemplate(userId, "copy_writer");
    const script = await writeCopy(
      product.name,
      brief,
      antiRepeat.recentHooks,
      antiRepeat.recentCtas,
      copyTemplate,
      remakeInstructions
    );
    await log(videoId, "write_copy", "completed", undefined, script, Date.now() - t4);

    const takeCount = Math.min(Object.keys(script.takeScripts).length, maxTakes);

    // ── Step 5: Generate Veo prompts ───────────────────────────────────────
    const t5 = Date.now();
    await setStep(videoId, "generating_veo_prompts");
    await log(videoId, "generate_veo_prompts", "started");

    // Persona é sorteada AQUI — é a ÚNICA coisa que muda em relação ao
    // vídeo de referência. Todo o resto (cenário, roupa, objetos, luz) é
    // extraído do vídeo de referência e replicado fielmente.
    const persona = pickRandomPersona();

    // Pega o vídeo de referência com mais views e analisa a thumbnail com
    // GPT-4o vision pra extrair a receita visual completa do cenário.
    const bestReference = [...product.detectedVideos]
      .sort((a, b) => Number((b.views ?? 0n) - (a.views ?? 0n)))
      .find((v) => v.thumbnailUrl);
    const referenceScene = bestReference?.thumbnailUrl
      ? await analyzeReferenceScene(
          bestReference.thumbnailUrl,
          product.name,
          bestReference.description ?? undefined
        )
      : null;
    if (referenceScene) {
      await log(videoId, "analyze_reference_scene", "completed", undefined, referenceScene);
    }

    // Transcreve o áudio do vídeo de referência (Whisper).
    let referenceTranscript: { transcript: string; hasSpeech: boolean; playUrl: string | null } | null = null;
    if (bestReference?.id) {
      referenceTranscript = await ensureReferenceTranscript(bestReference.id).catch((e) => { console.error("[pipeline] ensureReferenceTranscript failed:", e); return null; });
      if (referenceTranscript) {
        await log(videoId, "transcribe_reference", "completed", referenceTranscript.hasSpeech ? "has_speech" : "silent", {
          chars: referenceTranscript.transcript.length,
        });
      }
    }

    // Decide narração: usa a heurística do Whisper (hasSpeech).
    const hasNarration = referenceTranscript?.hasSpeech ?? false;

    if (!hasNarration) {
      script.fullScript = "";
      script.takeScripts = { take1: "", take2: "", take3: "" };
      brief.narrationMode = "voiceover_narrator";
    } else if (referenceTranscript?.hasSpeech && referenceTranscript.transcript.trim()) {
      const words = referenceTranscript.transcript.trim().split(/\s+/);
      const third = Math.ceil(words.length / 3);
      script.fullScript = referenceTranscript.transcript.trim();
      script.takeScripts = {
        take1: words.slice(0, third).join(" "),
        take2: words.slice(third, third * 2).join(" "),
        take3: words.slice(third * 2).join(" "),
      };
      brief.narrationMode = "creator_speaking";
    }

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: {
        script: script.fullScript,
        copyByTake: script.takeScripts,
        takeCount,
      },
    });

    const veoTemplate = await getTemplate(userId, "veo_prompt");
    const veoPrompts = await generateVeoPrompts(
      product.name,
      brief,
      script.takeScripts,
      veoTemplate,
      persona,
      referenceScene
    );
    await log(videoId, "generate_veo_prompts", "completed", undefined, veoPrompts, Date.now() - t5);

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { veoPrompts: veoPrompts as object },
    });

    // ── Extrai keyframes do vídeo de referência via ffmpeg scene detect ────
    // ffmpeg detecta automaticamente quando a imagem muda significativamente
    // (corte, troca de roupa, mudança de cor). Extrai 1 frame por take nos
    // pontos de mudança. Cada frame vai pro Nano Banana (troca SÓ a pessoa,
    // mantém cenário + roupa + cor exata daquele momento). O resultado vira
    // input image-to-video do Veo POR TAKE.
    let perTakeImages: Record<string, { data: string; mimeType: string } | null> = {};
    let editedImage: { data: string; mimeType: string } | null = null;

    let refPlayUrl = referenceTranscript?.playUrl ?? null;
    let refDuration: number | null = null;

    if (!refPlayUrl && bestReference?.videoUrl) {
      const tikwmDetail = await fetchTikwmDetail(bestReference.videoUrl).catch((e) => { console.error("[pipeline] tikwm fallback failed:", e); return null; });
      if (tikwmDetail) {
        refPlayUrl = tikwmDetail.playUrl;
        refDuration = tikwmDetail.durationSeconds;
      }
    }

    if (!refDuration && bestReference?.videoUrl && refPlayUrl) {
      const tikwmDetail = await fetchTikwmDetail(bestReference.videoUrl).catch(() => null);
      refDuration = tikwmDetail?.durationSeconds ?? null;
    }

    if (!refPlayUrl) {
      await log(videoId, "extract_keyframes", "failed", `no play URL — bestRef.videoUrl=${bestReference?.videoUrl ?? "null"}, transcript.playUrl=${referenceTranscript?.playUrl ?? "null"}`);
    }

    if (refPlayUrl) {
      await log(videoId, "extract_keyframes", "started", `duration=${refDuration ?? "unknown"}`);
      const keyframes = await extractKeyFrames(refPlayUrl, videoId, takeCount, refDuration).catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[pipeline] extractKeyFrames error:", msg);
        await log(videoId, "extract_keyframes", "failed", `ERROR: ${msg.slice(0, 500)}`);
        return null;
      });

      if (keyframes && keyframes.frames.length >= takeCount) {
        const frameUrls = keyframes.frames.map((f) => f.url);
        await log(videoId, "extract_keyframes", "completed", `${keyframes.frames.length} frames: ${frameUrls.join(", ")}`);

        for (let i = 0; i < takeCount; i++) {
          const key = `take${i + 1}`;
          await log(videoId, `nano_banana_${key}`, "started");
          const edited = await swapReferencePerson(keyframes.frames[i].url, persona).catch((e) => {
            console.error(`[pipeline] nano_banana ${key} error:`, e);
            return null;
          });
          if (edited) {
            perTakeImages[key] = await imageUrlToBase64(edited.url);
            await log(videoId, `nano_banana_${key}`, "completed", edited.url);
          } else {
            // Nano Banana falhou → usa o frame original como image-to-video.
            // Melhor que text-to-video puro — pelo menos o cenário/roupa/cor
            // está correto, mesmo que a pessoa seja a original.
            const rawFrame = await imageUrlToBase64(keyframes.frames[i].url);
            if (rawFrame) {
              perTakeImages[key] = rawFrame;
              await log(videoId, `nano_banana_${key}`, "failed", `using raw frame as fallback: ${keyframes.frames[i].url}`);
            } else {
              perTakeImages[key] = null;
              await log(videoId, `nano_banana_${key}`, "failed", "both nano banana and raw frame failed");
            }
          }
        }
      } else {
        await log(videoId, "extract_keyframes", "failed", `got ${keyframes?.frames.length ?? 0} frames, need ${takeCount}`);
      }
    }

    // Fallback: se não extraiu frames por take, tenta a thumbnail original
    if (!perTakeImages.take1 && bestReference?.thumbnailUrl) {
      await log(videoId, "nano_banana_edit", "started", "fallback — single thumbnail");
      const edited = await swapReferencePerson(bestReference.thumbnailUrl, persona).catch(() => null);
      if (edited) {
        editedImage = await imageUrlToBase64(edited.url);
        await log(videoId, "nano_banana_edit", "completed", edited.url);
      } else {
        // Usa a thumbnail original como fallback final
        editedImage = await imageUrlToBase64(bestReference.thumbnailUrl).catch(() => null);
        await log(videoId, "nano_banana_edit", "failed", editedImage ? "using raw thumbnail" : "all image methods failed, text-to-video");
      }
    }

    // ── Step 6: Generate audio narration ──────────────────────────────────
    // Só geramos TTS pro modo voiceover_narrator. No creator_speaking o Veo
    // já entrega lip-sync com voz própria — se a gente mandasse TTS por cima,
    // a voz do Veo e a voz do TTS apareceriam ao mesmo tempo (voz dupla).
    const t6 = Date.now();
    await setStep(videoId, "generating_audio");
    await log(videoId, "generate_audio", "started");

    const audioUrl = brief.narrationMode === "voiceover_narrator"
      ? await generateNarration(script.fullScript, voice, videoId)
      : null;
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { audioUrl } });
    await log(videoId, "generate_audio", "completed", audioUrl ? "Audio generated" : "Skipped (creator_speaking or empty)", undefined, Date.now() - t6);

    // ── Step 7: Submit Veo3 takes ──────────────────────────────────────────
    const t7 = Date.now();
    await setStep(videoId, "submitting_takes");
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "SUBMITTING_TAKES" } });
    await log(videoId, "submit_takes", "started");

    // Mantemos productImageUrl pra registrar no GenerationJob (histórico) mas
    // NÃO é mais input do Veo — usamos text-to-video pra ter uma pessoa nova
    // a cada geração.
    const productImageUrl = product.thumbnailUrl ?? product.detectedVideos[0]?.thumbnailUrl ?? "";

    const accessToken = await getAccessToken();

    const takePromptList = [veoPrompts.take1, veoPrompts.take2, veoPrompts.take3].slice(0, takeCount);

    for (let i = 0; i < takePromptList.length; i++) {
      const prompt = takePromptList[i];

      // Create GenerationJob for this take (reuses existing table)
      const genJob = await prisma.generationJob.create({
        data: {
          userId,
          status: "PROCESSING",
          provider: modelId,
          inputImageUrl: productImageUrl,
          promptText: prompt,
          generatedPrompt: prompt,
          aspectRatio: "RATIO_9_16",
          maxDuration: 8,
          externalTaskId: "", // Will be updated below
          startedAt: new Date(),
        },
      });

      // Create UgcGeneratedTake
      const take = await prisma.ugcGeneratedTake.create({
        data: {
          videoId,
          userId,
          takeIndex: i,
          veoJobId: genJob.id,
          veoPrompt: prompt,
          script: Object.values(script.takeScripts)[i] ?? "",
          status: "QUEUED",
        },
      });

      // Escolhe a imagem certa pro take: per-take frame editado (ideal) →
      // thumbnail editada (fallback) → text-to-video puro (último recurso).
      const takeKey = `take${i + 1}` as "take1" | "take2" | "take3";
      const takeImage = perTakeImages[takeKey] ?? editedImage;

      // Submit to Vertex AI — retry without image if Veo rejects it
      try {
        const operationName = await submitVeoTake(prompt, modelId, accessToken, takeImage);
        await prisma.generationJob.update({
          where: { id: genJob.id },
          data: { externalTaskId: operationName },
        });
        await prisma.ugcGeneratedTake.update({
          where: { id: take.id },
          data: { status: "PROCESSING" },
        });
      } catch (err) {
        const errMsg = String(err);
        if (takeImage && (errMsg.includes("usage guidelines") || errMsg.includes("violat"))) {
          console.warn(`[pipeline] Veo rejected image for take ${i}, retrying text-to-video`);
          try {
            const operationName = await submitVeoTake(prompt, modelId, accessToken, null);
            await prisma.generationJob.update({
              where: { id: genJob.id },
              data: { externalTaskId: operationName },
            });
            await prisma.ugcGeneratedTake.update({
              where: { id: take.id },
              data: { status: "PROCESSING" },
            });
          } catch (retryErr) {
            await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: String(retryErr) } });
            await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: `Image rejected, text-to-video also failed: ${String(retryErr)}` } });
          }
        } else {
          await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: errMsg } });
          await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: errMsg } });
        }
      }
    }

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "GENERATING_TAKES" },
    });
    await log(videoId, "submit_takes", "completed", `${takePromptList.length} takes submitted`, undefined, Date.now() - t7);

    // Record used elements for anti-repetition
    await recordUsedElements(userId, {
      hook: script.hookUsed,
      cta: script.ctaUsed,
      angle: script.angleUsed,
      style: script.styleUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(videoId, video.currentStep ?? "pipeline", "failed", msg);
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "FAILED", errorMessage: msg },
    });
    throw err;
  }
}

// ── Poll and assemble takes ────────────────────────────────────────────────
// Called by the frontend poller when all takes are done

export async function pollAndAssembleTakes(videoId: string): Promise<{
  allDone: boolean;
  failedCount: number;
  status: string;
}> {
  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id: videoId },
    include: { takes: true },
  });
  if (!video) throw new Error("Video not found");
  if (video.status !== "GENERATING_TAKES") {
    return { allDone: false, failedCount: 0, status: video.status };
  }

  // Check status of all GenerationJobs
  const accessToken = await getAccessToken().catch(() => null);
  let allCompleted = true;
  let failedCount = 0;

  for (const take of video.takes) {
    if (take.status === "COMPLETED") continue;
    if (take.status === "FAILED") { failedCount++; continue; }
    if (!take.veoJobId || !accessToken) { allCompleted = false; continue; }

    const genJob = await prisma.generationJob.findUnique({ where: { id: take.veoJobId } });
    if (!genJob) { allCompleted = false; continue; }

    if (genJob.status === "COMPLETED" && genJob.outputVideoUrl) {
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "COMPLETED", videoUrl: genJob.outputVideoUrl },
      });
      continue;
    }
    if (genJob.status === "FAILED") {
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "FAILED", errorMessage: genJob.errorMessage },
      });
      failedCount++;
      continue;
    }

    // Poll Vertex AI
    if (!genJob.externalTaskId) { allCompleted = false; continue; }
    try {
      const opName = genJob.externalTaskId;
      const modelMatch = opName.match(/publishers\/google\/models\/([^/]+)\//);
      const modelId = modelMatch?.[1] ?? "veo-3.0-fast-generate-001";
      const fetchOpUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT ?? PROJECT_ID}/locations/us-central1/publishers/google/models/${modelId}:fetchPredictOperation`;

      const opRes = await fetch(fetchOpUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operationName: opName }),
      });
      const opData = (await opRes.json()) as {
        done?: boolean;
        error?: { message: string };
        response?: { videos?: Array<{ uri?: string; bytesBase64Encoded?: string }> };
      };

      if (!opData.done) { allCompleted = false; continue; }

      if (opData.error) {
        await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: opData.error.message } });
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: opData.error.message } });
        failedCount++;
        continue;
      }

      // Extract video
      const videoEntry = opData.response?.videos?.[0];
      const rawBase64 = videoEntry?.bytesBase64Encoded;
      const rawUri = videoEntry?.uri;

      let videoUrl: string;
      if (rawBase64) {
        const videoBuffer = Buffer.from(rawBase64, "base64");
        const blob = await put(`ugc-take-${take.id}.mp4`, videoBuffer, { access: "public", contentType: "video/mp4", addRandomSuffix: false });
        videoUrl = blob.url;
      } else if (rawUri) {
        // Download from GCS
        const withoutScheme = rawUri.startsWith("gs://") ? rawUri.slice(5) : rawUri;
        const slashIdx = withoutScheme.indexOf("/");
        const bucket = withoutScheme.slice(0, slashIdx);
        const object = encodeURIComponent(withoutScheme.slice(slashIdx + 1));
        const gcsRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const buf = await gcsRes.arrayBuffer();
        const blob = await put(`ugc-take-${take.id}.mp4`, Buffer.from(buf), { access: "public", contentType: "video/mp4", addRandomSuffix: false });
        videoUrl = blob.url;
      } else {
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: "No video returned" } });
        failedCount++;
        continue;
      }

      await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "COMPLETED", outputVideoUrl: videoUrl, completedAt: new Date() } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "COMPLETED", videoUrl } });
    } catch {
      allCompleted = false;
    }
  }

  if (failedCount === video.takes.length) {
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "FAILED", errorMessage: "All takes failed" } });
    return { allDone: true, failedCount, status: "FAILED" };
  }

  if (!allCompleted) {
    return { allDone: false, failedCount, status: "GENERATING_TAKES" };
  }

  // All done — assemble
  await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "ASSEMBLING" } });
  await log(videoId, "assemble", "started");

  try {
    const completedTakes = await prisma.ugcGeneratedTake.findMany({
      where: { videoId, status: "COMPLETED" },
      orderBy: { takeIndex: "asc" },
    });

    const takeInfos = completedTakes
      .filter((t) => t.videoUrl)
      .map((t) => ({ url: t.videoUrl! }));

    const freshVideo = await prisma.ugcGeneratedVideo.findUnique({ where: { id: videoId } });
    const result = await assembleTakes(takeInfos, freshVideo?.audioUrl ?? null, videoId);

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: {
        status: "AWAITING_REVIEW",
        finalVideoUrl: result.finalVideoUrl,
        durationSeconds: result.durationSeconds,
        generationCompletedAt: new Date(),
        currentStep: null,
      },
    });
    await log(videoId, "assemble", "completed", `Final video: ${result.finalVideoUrl}`);
    return { allDone: true, failedCount, status: "AWAITING_REVIEW" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(videoId, "assemble", "failed", msg);
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "FAILED", errorMessage: msg } });
    throw err;
  }
}
