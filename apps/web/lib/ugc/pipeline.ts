// Main UGC pipeline orchestrator
// Runs each step, logs to DB, handles errors gracefully
// Reuses the Veo3 integration (same Vertex AI code as /api/animate-veo3)

import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { GoogleAuth } from "google-auth-library";
import { analyzeCreative, generateBrief, writeCopy, generateVeoPrompts, parseRemakeFeedback, analyzeReferenceScene } from "./llm";
import { generateNarration } from "./tts";
import { assembleTakes } from "./assembler";
import { getAntiRepeatContext, recordUsedElements, getNegativePatterns } from "./anti-repeat";
import { DEFAULT_PROMPT_TEMPLATES } from "./defaults";
import { ensureReferenceTranscript, fetchTikwmDetail, extractKeyFrames, analyzeReferenceVideoWithGemini, TranscriptSegment, VoiceStyle, SceneBreakdown } from "./reference-video";
import { swapPersonWithAvatar, swapAllPhenotypes, imageUrlToBase64 } from "./nano-banana";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { execFile } from "child_process";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Get video duration using ffmpeg (no ffprobe needed)
function getVideoDurationFfmpeg(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    const proc = execFile(ffmpegInstaller.path, ["-i", videoPath, "-f", "null", "-"], { timeout: 15000 });
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const centis = parseInt(match[4]);
        resolve(hours * 3600 + minutes * 60 + seconds + centis / 100);
      } else {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

// Trim trailing silence from a video buffer.
// Returns trimmed buffer if silence was found, or original buffer if not.
async function trimTrailingSilenceFromBuffer(videoBuffer: Buffer): Promise<Buffer> {
  const id = randomBytes(6).toString("hex");
  const tmpDir = join("/tmp", `trim-silence-${id}`);
  await mkdir(tmpDir, { recursive: true });
  const inputPath = join(tmpDir, "input.mp4");
  const outputPath = join(tmpDir, "trimmed.mp4");

  try {
    await writeFile(inputPath, videoBuffer);

    // Detect silence periods using ffmpeg silencedetect — mais sensível (-35dB, 0.3s)
    const silenceInfo = await new Promise<string>((resolve) => {
      let stderr = "";
      ffmpeg(inputPath)
        .audioFilters("silencedetect=noise=-35dB:d=0.3")
        .format("null")
        .output(process.platform === "win32" ? "NUL" : "/dev/null")
        .on("stderr", (line: string) => { stderr += line + "\n"; })
        .on("end", () => resolve(stderr))
        .on("error", () => resolve(stderr))
        .run();
    });

    // Parse silence_start timestamps — find the last one
    const silenceStartMatches = [...silenceInfo.matchAll(/silence_start:\s*([\d.]+)/g)];
    const duration = await getVideoDurationFfmpeg(inputPath);

    if (silenceStartMatches.length === 0 || duration <= 0) {
      console.log(`[trimSilence] No trailing silence detected (duration=${duration})`);
      return videoBuffer;
    }

    const lastSilenceStart = parseFloat(silenceStartMatches[silenceStartMatches.length - 1][1]);
    // Only trim if the silence is at the END of the video (last 30% of duration)
    // and is significant (> 0.4s)
    const trailingSilenceDuration = duration - lastSilenceStart;
    if (trailingSilenceDuration < 0.4 || lastSilenceStart < duration * 0.5) {
      console.log(`[trimSilence] Silence not significant enough to trim (starts at ${lastSilenceStart}s, duration=${duration}s, trailing=${trailingSilenceDuration}s)`);
      return videoBuffer;
    }

    // Keep a small buffer (0.15s) after last speech
    const trimPoint = Math.min(lastSilenceStart + 0.15, duration);
    console.log(`[trimSilence] Trimming at ${trimPoint}s (was ${duration}s, cutting ${(duration - trimPoint).toFixed(1)}s of silence)`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(trimPoint)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const trimmedBuffer = await readFile(outputPath);
    console.log(`[trimSilence] Trimmed: ${videoBuffer.byteLength} → ${trimmedBuffer.byteLength} bytes`);
    return trimmedBuffer;
  } catch (err) {
    console.error("[trimSilence] Error, returning original:", err);
    return videoBuffer;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
    await import("fs/promises").then(fs => fs.rmdir(tmpDir).catch(() => {}));
  }
}

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
  image?: { data: string; mimeType: string } | null,
  durationSeconds: number = 8
): Promise<string> {
  const veoModel = VEO3_MODEL_IDS[modelId] ?? "veo-3.0-fast-generate-001";
  const instance: Record<string, unknown> = { prompt };
  if (image) {
    instance.image = { bytesBase64Encoded: image.data, mimeType: image.mimeType };
  }
  const res = await fetch(`${VERTEX_BASE}/${veoModel}:predictLongRunning`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      instances: [instance],
      parameters: { aspectRatio: "9:16", durationSeconds, sampleCount: 1 },
    }),
  });
  const data = (await res.json()) as { name?: string; error?: { message: string } };
  if (!res.ok || !data.name) throw new Error(data.error?.message ?? "Veo3 submission failed");
  return data.name;
}

// ── Extract last frame from video ──────────────────────────────────────────
// Downloads a video, extracts the last frame as JPEG, returns base64.
// Used to chain speech takes: last frame of take N → input image of take N+1.

async function extractLastFrame(videoUrl: string): Promise<{ data: string; mimeType: string } | null> {
  const id = randomBytes(6).toString("hex");
  const tmpDir = join("/tmp", `lastframe-${id}`);
  await mkdir(tmpDir, { recursive: true });
  const videoPath = join(tmpDir, "video.mp4");
  const framePath = join(tmpDir, "lastframe.jpg");

  try {
    // Download video — tenta com e sem token
    console.log(`[extractLastFrame] Downloading: ${videoUrl.substring(0, 80)}...`);
    let res = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    // Se 403, tenta com token do Blob
    if (!res || !res.ok) {
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (blobToken && videoUrl.includes("blob.vercel-storage.com")) {
        console.log(`[extractLastFrame] Got ${res?.status ?? "error"}, retrying with BLOB_READ_WRITE_TOKEN...`);
        res = await fetch(videoUrl, {
          signal: AbortSignal.timeout(30000),
          headers: { "Authorization": `Bearer ${blobToken}` },
        }).catch(() => null);
      }
    }
    // Se ainda falha, tenta via download endpoint do Vercel Blob
    if (!res || !res.ok) {
      console.log(`[extractLastFrame] Still failing (${res?.status ?? "error"}), trying x-vercel-blob-download...`);
      res = await fetch(videoUrl, {
        signal: AbortSignal.timeout(30000),
        headers: { "x-vercel-blob-download": "1" },
      }).catch(() => null);
    }
    if (!res || !res.ok) {
      console.error(`[extractLastFrame] Download failed after all attempts: ${res?.status ?? "error"}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    console.log(`[extractLastFrame] Downloaded ${buf.byteLength} bytes`);
    await writeFile(videoPath, Buffer.from(buf));

    // Get duration
    const duration = await getVideoDurationFfmpeg(videoPath);
    console.log(`[extractLastFrame] duration: ${duration}`);
    if (duration <= 0) {
      console.error(`[extractLastFrame] Invalid duration: ${duration}`);
      return null;
    }

    // Extract frame at (duration - 0.1s) to get the very last usable frame
    const seekTime = Math.max(0, duration - 0.1);
    console.log(`[extractLastFrame] Extracting frame at ${seekTime}s (duration=${duration}s)`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .output(framePath)
        .outputOptions(["-q:v", "2"]) // high quality JPEG
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const frameBuffer = await readFile(framePath);
    console.log(`[extractLastFrame] Frame extracted: ${frameBuffer.byteLength} bytes at ${seekTime}s`);
    return {
      data: frameBuffer.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (err) {
    console.error("[extractLastFrame] FAILED:", err);
    return null;
  } finally {
    await unlink(videoPath).catch(() => {});
    await unlink(framePath).catch(() => {});
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
}

// ── Extract frame at a specific offset (seconds before end) from a video URL ──
// Used for retries when the last frame gets rejected by Veo content filter.
// offsetFromEnd: seconds before the end (e.g., 0.5 = half second before end, 1.0 = 1s before end)
async function extractFrameAtOffset(videoUrl: string, offsetFromEnd: number): Promise<{ data: string; mimeType: string } | null> {
  const id = randomBytes(6).toString("hex");
  const tmpDir = join("/tmp", `frame-offset-${id}`);
  await mkdir(tmpDir, { recursive: true });
  const videoPath = join(tmpDir, "video.mp4");
  const framePath = join(tmpDir, "frame.jpg");

  try {
    let res = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!res || !res.ok) {
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      if (blobToken && videoUrl.includes("blob.vercel-storage.com")) {
        res = await fetch(videoUrl, { signal: AbortSignal.timeout(30000), headers: { "Authorization": `Bearer ${blobToken}` } }).catch(() => null);
      }
    }
    if (!res || !res.ok) return null;

    await writeFile(videoPath, Buffer.from(await res.arrayBuffer()));
    const duration = await getVideoDurationFfmpeg(videoPath);
    if (duration <= 0) return null;

    const seekTime = Math.max(0, duration - offsetFromEnd);
    console.log(`[extractFrameAtOffset] Extracting frame at ${seekTime}s (duration=${duration}s, offset=${offsetFromEnd}s)`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .output(framePath)
        .outputOptions(["-q:v", "2"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const frameBuffer = await readFile(framePath);
    return { data: frameBuffer.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  } finally {
    await unlink(videoPath).catch(() => {});
    await unlink(framePath).catch(() => {});
    await import("fs/promises").then(fs => fs.rmdir(tmpDir).catch(() => {}));
  }
}

// ── Extract last frame from video buffer in memory ────────────────────────
// Takes a video buffer already in memory, writes to /tmp, extracts last frame.
// Avoids re-downloading from blob (which can return 403).

async function extractLastFrameFromBuffer(videoBuffer: Buffer): Promise<{ data: string; mimeType: string } | null> {
  const id = randomBytes(6).toString("hex");
  const tmpDir = join("/tmp", `lastframe-buf-${id}`);
  await mkdir(tmpDir, { recursive: true });
  const videoPath = join(tmpDir, "video.mp4");
  const framePath = join(tmpDir, "lastframe.jpg");

  try {
    await writeFile(videoPath, videoBuffer);
    console.log(`[extractLastFrameFromBuffer] Wrote ${videoBuffer.byteLength} bytes to ${videoPath}`);

    const duration = await getVideoDurationFfmpeg(videoPath);
    if (duration <= 0) {
      console.error(`[extractLastFrameFromBuffer] Invalid duration: ${duration}`);
      return null;
    }

    const seekTime = Math.max(0, duration - 0.1);
    console.log(`[extractLastFrameFromBuffer] Extracting frame at ${seekTime}s (duration=${duration}s)`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .output(framePath)
        .outputOptions(["-q:v", "2"])
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });

    const frameBuffer = await readFile(framePath);
    console.log(`[extractLastFrameFromBuffer] Frame extracted: ${frameBuffer.byteLength} bytes`);
    return { data: frameBuffer.toString("base64"), mimeType: "image/jpeg" };
  } catch (err) {
    console.error("[extractLastFrameFromBuffer] FAILED:", err);
    return null;
  } finally {
    await unlink(videoPath).catch(() => {});
    await unlink(framePath).catch(() => {});
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
}

// ── Persist last frame to Vercel Blob from a buffer ───────────────────────

async function persistLastFrame(frame: { data: string; mimeType: string }, takeId: string): Promise<string | null> {
  try {
    const blob = await put(`ugc-lastframe-${takeId}.jpg`, Buffer.from(frame.data, "base64"), {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: false,
    });
    console.log(`[persistLastFrame] Saved: ${blob.url}`);
    await prisma.ugcGeneratedTake.update({
      where: { id: takeId },
      data: { lastFrameUrl: blob.url },
    });
    return blob.url;
  } catch (err) {
    console.error(`[persistLastFrame] Upload failed:`, err);
    return null;
  }
}

// ── Extract last frame from URL (downloads first) ────────────────────────
// Fallback for when we don't have the buffer in memory.
// Uses BLOB_READ_WRITE_TOKEN for authenticated access if available.

async function extractAndPersistLastFrame(videoUrl: string, takeId: string): Promise<string | null> {
  const frame = await extractLastFrame(videoUrl);
  if (!frame) {
    console.error(`[extractAndPersistLastFrame] Failed for take ${takeId}`);
    return null;
  }
  return persistLastFrame(frame, takeId);
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
    include: {
      product: { include: { detectedVideos: true } },
      character: true,
    },
  });
  if (!video) throw new Error(`Video ${videoId} not found`);

  const userId = video.userId;
  const product = video.product;
  const characterImageUrl = video.character?.imageUrl ?? null;
  // Sem personagem = modo "phenotype swap" (troca fenótipo de todos via prompt).
  const phenotypeOnlyMode = !characterImageUrl;
  // "continuous" = encadeia takes pelo último frame (padrão, fala suave)
  // "hard_cuts"  = cada take em paralelo com frame próprio (imita cortes secos)
  const transitionMode: string = (video as unknown as { transitionMode?: string }).transitionMode ?? "continuous";

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
    // Para fala, o pipeline precisa de ceil(duração/8) takes no mínimo.
    // Não pode limitar abaixo disso senão perde palavras. Safety cap alto.
    const maxTakes = 15;

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

    // ── Step 5: Analyze reference video + determine take count ──────────
    const t5 = Date.now();
    await setStep(videoId, "generating_veo_prompts");
    await log(videoId, "generate_veo_prompts", "started");

    // Pega o vídeo de referência com mais views
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

    // ── Gemini analisa o vídeo inteiro: narração + número de cenas ─────
    // O Gemini determina:
    // 1) Se tem fala ou só música → decide se avatar fala ou fica calado
    // 2) Quantas cenas/trocas de roupa tem → determina o número de takes

    let refPlayUrl_narration = null as string | null;
    let refDuration_fromTikwm: number | null = null;
    if (bestReference?.videoUrl) {
      const tikwm = await fetchTikwmDetail(bestReference.videoUrl).catch(() => null);
      refPlayUrl_narration = tikwm?.playUrl ?? null;
      refDuration_fromTikwm = tikwm?.durationSeconds ?? null;
    }

    let hasNarration = false;
    let geminiSceneCount = 3; // fallback se Gemini não funcionar
    let referenceVoiceStyle: VoiceStyle | null = null;
    let referenceScenes: SceneBreakdown[] = [];
    if (refPlayUrl_narration) {
      await log(videoId, "narration_detection", "started", "Gemini analyzing video for speech vs music + scene count");

      // Tenta Gemini até 2x (a API pode falhar esporadicamente)
      let geminiAnalysis = await analyzeReferenceVideoWithGemini(refPlayUrl_narration, product.name).catch((e) => {
        console.error("[pipeline] Gemini video analysis attempt 1 failed:", e);
        return null;
      });
      if (!geminiAnalysis) {
        await log(videoId, "narration_detection", "started", "Gemini attempt 1 failed, retrying...");
        geminiAnalysis = await analyzeReferenceVideoWithGemini(refPlayUrl_narration, product.name).catch((e) => {
          console.error("[pipeline] Gemini video analysis attempt 2 failed:", e);
          return null;
        });
      }

      if (geminiAnalysis) {
        hasNarration = geminiAnalysis.hasNarration && geminiAnalysis.narrationStyle !== "none";
        if (geminiAnalysis.sceneCount && geminiAnalysis.sceneCount > 0) {
          geminiSceneCount = geminiAnalysis.sceneCount;
        }
        if (hasNarration && geminiAnalysis.voiceStyle) {
          referenceVoiceStyle = geminiAnalysis.voiceStyle;
        }
        if (geminiAnalysis.scenes && geminiAnalysis.scenes.length > 0) {
          referenceScenes = geminiAnalysis.scenes;
        }
        await log(videoId, "narration_detection", "completed",
          `Gemini says: narrationStyle=${geminiAnalysis.narrationStyle}, sceneCount=${geminiAnalysis.sceneCount}, hasNarration=${geminiAnalysis.hasNarration} → speech: ${hasNarration ? "SPEAKING" : "SILENT"}, takes: ${geminiSceneCount}${referenceVoiceStyle ? `, voice: ${referenceVoiceStyle.description.slice(0, 80)}` : ""}`, {
          narrationStyle: geminiAnalysis.narrationStyle,
          narrationSummary: geminiAnalysis.narrationSummary,
          voiceStyle: geminiAnalysis.voiceStyle,
          sceneCount: geminiAnalysis.sceneCount,
          scenes: geminiAnalysis.scenes,
        });
      } else {
        // Gemini falhou 2x → scene count será determinado pelo ffmpeg scene detection
        // no passo de extractKeyFrames (detecta cortes visuais automaticamente).
        // Por enquanto, marca como "pendente ffmpeg" — o valor será sobrescrito.
        hasNarration = false;
        geminiSceneCount = 0; // 0 = "não sabe, deixa o ffmpeg decidir"
        await log(videoId, "narration_detection", "failed",
          "Gemini failed 2x → SILENT, scene count will be determined by ffmpeg scene detection");
      }
    } else {
      await log(videoId, "narration_detection", "completed", "No video URL available → defaulting to SILENT, 3 takes");
    }

    // takeCount = max(cenas visuais, takes mínimos pela duração da fala)
    // - Cenas visuais: cada troca de roupa/cenário = 1 take
    // - Fala: ceil(duração / 8) takes mínimos (cada take Veo = max 8s)
    const speechMinTakes = hasNarration && refDuration_fromTikwm && refDuration_fromTikwm > 0
      ? Math.ceil(refDuration_fromTikwm / 8)
      : 0;
    const geminiProvidedSceneCount = geminiSceneCount > 0;
    let takeCount = Math.min(
      Math.max(geminiSceneCount, speechMinTakes, 1),
      maxTakes
    );
    await log(videoId, "take_count", "completed",
      `Initial: ${takeCount} takes (geminiScenes=${geminiSceneCount}, speechMin=${speechMinTakes}, duration=${refDuration_fromTikwm ?? "?"}s, max=${maxTakes})`);

    // Se tem fala real, pega o conteúdo via Whisper (para usar depois do takeCount final)
    let referenceTranscript: { transcript: string; hasSpeech: boolean; playUrl: string | null; segments?: TranscriptSegment[] } | null = null;
    if (hasNarration && bestReference?.id) {
      referenceTranscript = await ensureReferenceTranscript(bestReference.id).catch((e) => {
        console.error("[pipeline] ensureReferenceTranscript failed:", e);
        return null;
      });
    }

    // NOTA: takeScripts e veoPrompts serão gerados APÓS extractKeyFrames,
    // porque o ffmpeg scene detection pode atualizar o takeCount.

    // ── Extrai keyframes do vídeo de referência via ffmpeg scene detect ────
    // ffmpeg detecta automaticamente quando a imagem muda significativamente
    // (corte, troca de roupa, mudança de cor). Extrai 1 frame por take nos
    // pontos de mudança. Cada frame vai pro Nano Banana (troca SÓ a pessoa,
    // mantém cenário + roupa + cor exata daquele momento). O resultado vira
    // input image-to-video do Veo POR TAKE.
    let perTakeImages: Record<string, { data: string; mimeType: string } | null> = {};
    let referenceFrameUrls: Record<string, string> = {}; // raw keyframe URLs por take
    let perTakeEditedUrls: Record<string, string | null> = {}; // Nano Banana result URLs por take
    let editedImage: { data: string; mimeType: string } | null = null;
    let editedImageUrl: string | null = null; // fallback edited image URL

    // Reutiliza a URL e duração do tikwm que já pegamos antes do Gemini
    const refPlayUrl = refPlayUrl_narration;
    const refDuration = refDuration_fromTikwm;

    if (!refPlayUrl) {
      await log(videoId, "extract_keyframes", "failed", `no play URL — bestRef.videoUrl=${bestReference?.videoUrl ?? "null"}`);
    }

    if (refPlayUrl) {
      await log(videoId, "extract_keyframes", "started", `duration=${refDuration ?? "unknown"}, targetTakes=${takeCount}, geminiProvided=${geminiProvidedSceneCount}`);
      const keyframes = await extractKeyFrames(refPlayUrl, videoId, takeCount, refDuration).catch(async (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[pipeline] extractKeyFrames error:", msg);
        await log(videoId, "extract_keyframes", "failed", `ERROR: ${msg.slice(0, 500)}`);
        return null;
      });

      if (keyframes && keyframes.frames.length > 0) {
        // Número de cenas VISUAIS distintas (cada troca de roupa/cenário = 1 cena)
        const visualScenes = keyframes.detectedSceneCount > 0
          ? keyframes.detectedSceneCount
          : keyframes.frames.length;

        // Para vídeos SEM fala (outfit changes), o takeCount = cenas visuais
        if (!hasNarration) {
          if (visualScenes > takeCount || (!geminiProvidedSceneCount && visualScenes > 0)) {
            const oldCount = takeCount;
            takeCount = Math.min(visualScenes, maxTakes);
            await log(videoId, "take_count_updated", "completed",
              `Visual scenes: ${visualScenes} (was ${oldCount}), updated to ${takeCount}`);
          }
          // Ajusta para não exceder frames disponíveis
          const actualTakeCount = Math.min(takeCount, keyframes.frames.length);
          if (actualTakeCount !== takeCount) {
            await log(videoId, "take_count_adjusted", "completed",
              `Adjusted from ${takeCount} to ${actualTakeCount} (only ${keyframes.frames.length} frames available)`);
            takeCount = actualTakeCount;
          }
        }
        // Para vídeos COM fala, takeCount já foi calculado por speechMinTakes
        // e NÃO deve ser reduzido pelo número de frames — vários takes podem
        // compartilhar o mesmo frame visual.

        const frameUrls = keyframes.frames.map((f) => f.url);
        await log(videoId, "extract_keyframes", "completed",
          `${keyframes.frames.length} frames (${visualScenes} visual scenes), takeCount=${takeCount}, hasNarration=${hasNarration}`);

        // ── Edita frames via Nano Banana ──
        // Para vídeos de FALA: edita só os frames visuais distintos e reutiliza
        // a mesma imagem para takes que pertencem à mesma cena. Garante que o
        // avatar seja IDÊNTICO em todos os takes.
        // Para vídeos de TROCA DE ROUPA: cada take tem seu frame único.

        const distinctFrameCount = Math.min(keyframes.frames.length, takeCount);
        let take1ResultUrl: string | null = null;
        const editedByFrame: Record<number, { data: string; mimeType: string } | null> = {};
        const editedUrlByFrame: Record<number, string | null> = {};

        // Edita os frames visuais distintos.
        // Frame 0 roda SEQUENCIAL (estabelece a referência de consistência).
        // Frames 1..N-1 rodam em PARALELO (todos usam take1ResultUrl, não dependem entre si).
        const mode = phenotypeOnlyMode ? "phenotype-only" : "avatar-swap";

        const editFrame = async (fi: number, prevRefUrl: string | null) => {
          // Cena correspondente (pode vir do Gemini breakdown). Se tem múltiplas
          // pessoas, avisa o Nano Banana pra não apagar ninguém.
          const sceneForFrame = referenceScenes[fi];
          const sceneGroupInfo = sceneForFrame && sceneForFrame.peopleCount && sceneForFrame.peopleCount > 1
            ? { peopleCount: sceneForFrame.peopleCount, description: sceneForFrame.visuals }
            : null;
          await log(videoId, `nano_banana_frame${fi + 1}`, "started",
            `[${mode}] frame ${fi + 1}${prevRefUrl ? " + prev take result" : ""}${sceneGroupInfo ? ` (GROUP: ${sceneGroupInfo.peopleCount} people)` : ""}`);
          // Tentativa 1 + 1 retry (Gemini imagens é estocástico — retry costuma funcionar)
          const doSwap = () => phenotypeOnlyMode
            ? swapAllPhenotypes(keyframes.frames[fi].url, prevRefUrl)
                .catch((e) => { console.error(`[pipeline] phenotype swap frame${fi + 1} error:`, e); return null; })
            : swapPersonWithAvatar(keyframes.frames[fi].url, characterImageUrl!, prevRefUrl, sceneGroupInfo)
                .catch((e) => { console.error(`[pipeline] nano_banana frame${fi + 1} error:`, e); return null; });
          let edited: { url: string; mimeType: string } | null = await doSwap();
          if (!edited) {
            await log(videoId, `nano_banana_frame${fi + 1}`, "started", `retry after first failure`);
            edited = await doSwap();
          }
          if (edited) {
            editedByFrame[fi] = await imageUrlToBase64(edited.url);
            editedUrlByFrame[fi] = edited.url;
            await log(videoId, `nano_banana_frame${fi + 1}`, "completed", edited.url);
            return edited.url;
          } else {
            const rawFrame = await imageUrlToBase64(keyframes.frames[fi].url);
            editedByFrame[fi] = rawFrame;
            editedUrlByFrame[fi] = null;
            await log(videoId, `nano_banana_frame${fi + 1}`, "failed",
              rawFrame ? `using raw frame: ${keyframes.frames[fi].url}` : "all image methods failed");
            return null;
          }
        };

        if (distinctFrameCount > 0) {
          take1ResultUrl = await editFrame(0, null);
          if (distinctFrameCount > 1) {
            const parallelStart = Date.now();
            await log(videoId, `nano_banana_parallel`, "started",
              `editing ${distinctFrameCount - 1} remaining frames in parallel`);
            await Promise.all(
              Array.from({ length: distinctFrameCount - 1 }, (_, idx) =>
                editFrame(idx + 1, take1ResultUrl)
              )
            );
            await log(videoId, `nano_banana_parallel`, "completed",
              `${distinctFrameCount - 1} frames done in ${Date.now() - parallelStart}ms`);
          }
        }

        // Mapeia cada take para o frame visual correto
        for (let i = 0; i < takeCount; i++) {
          const key = `take${i + 1}`;
          // Para vídeos de fala com 1 cena: todos os takes usam o frame 0
          // Para vídeos com N cenas: take i usa frame i (ou último disponível)
          const frameIdx = Math.min(i, distinctFrameCount - 1);
          perTakeImages[key] = editedByFrame[frameIdx] || null;
          perTakeEditedUrls[key] = editedUrlByFrame[frameIdx] || null;
          referenceFrameUrls[key] = keyframes.frames[Math.min(i, keyframes.frames.length - 1)].url;
        }
      } else {
        await log(videoId, "extract_keyframes", "failed", `got ${keyframes?.frames.length ?? 0} frames`);
      }
    }

    // Fallback: se não extraiu frames por take, tenta a thumbnail original
    if (!perTakeImages.take1 && bestReference?.thumbnailUrl) {
      await log(videoId, "nano_banana_edit", "started",
        phenotypeOnlyMode ? "fallback — thumbnail + phenotype swap" : "fallback — single thumbnail + avatar");
      const edited = phenotypeOnlyMode
        ? await swapAllPhenotypes(bestReference.thumbnailUrl).catch(() => null)
        : await swapPersonWithAvatar(bestReference.thumbnailUrl, characterImageUrl!).catch(() => null);
      if (edited) {
        editedImage = await imageUrlToBase64(edited.url);
        editedImageUrl = edited.url;
        await log(videoId, "nano_banana_edit", "completed", edited.url);
      } else {
        // Usa a thumbnail original como fallback final
        editedImage = await imageUrlToBase64(bestReference.thumbnailUrl).catch(() => null);
        await log(videoId, "nano_banana_edit", "failed", editedImage ? "using raw thumbnail" : "all image methods failed, text-to-video");
      }
    }

    // ── Agora que o takeCount final está definido (Gemini + ffmpeg scene detection),
    // gera os takeScripts e veoPrompts com o número correto de takes ──────────

    // Aplica a decisão de narração — gera takeScripts dinâmicos
    if (!hasNarration) {
      script.fullScript = "";
      const emptyScripts: Record<string, string> = {};
      for (let i = 0; i < takeCount; i++) emptyScripts[`take${i + 1}`] = "";
      script.takeScripts = emptyScripts;
      brief.narrationMode = "voiceover_narrator";
      await log(videoId, "narration_decision", "completed", `SILENT — avatar will NOT speak. ${takeCount} silent takes.`);
    } else if (referenceTranscript?.transcript?.trim()) {
      script.fullScript = referenceTranscript.transcript.trim();
      const takeScripts: Record<string, string> = {};

      // ── Split por segmentos Whisper (preserva TODAS as palavras, tom e pausas) ──
      // Cada segmento Whisper é uma frase/oração natural com timestamps reais.
      // Agrupamos segmentos consecutivos respeitando o limite de 8s do Veo.
      // NUNCA modifica o texto — usa exatamente o que o Whisper detectou.
      const MAX_TAKE_DURATION = 8; // Veo max

      const segments = referenceTranscript.segments;
      if (segments && segments.length > 0) {
        // ── MODO SEGMENTOS: usa timestamps reais do Whisper ──
        // Agrupa segmentos consecutivos em takes de até 8s.
        // Cada take contém orações completas — nunca corta no meio.
        // Se um segmento único passar de 8s, divide por palavras (tempo:texto
        // proporcional) pra garantir que TODAS as palavras passam pro Veo sem
        // serem truncadas no hard cap de 8s.
        const splitLongSegment = (seg: TranscriptSegment, maxDur: number): TranscriptSegment[] => {
          const segDur = seg.end - seg.start;
          if (segDur <= maxDur) return [seg];
          const words = seg.text.split(/\s+/).filter(Boolean);
          if (words.length === 0) return [seg];
          const parts = Math.ceil(segDur / maxDur);
          const wordsPerPart = Math.ceil(words.length / parts);
          const out: TranscriptSegment[] = [];
          for (let p = 0; p < parts; p++) {
            const wordStart = p * wordsPerPart;
            const wordEnd = Math.min((p + 1) * wordsPerPart, words.length);
            if (wordStart >= wordEnd) break;
            const tStart = seg.start + (wordStart / words.length) * segDur;
            const tEnd = seg.start + (wordEnd / words.length) * segDur;
            out.push({
              start: tStart,
              end: tEnd,
              text: words.slice(wordStart, wordEnd).join(" "),
            });
          }
          return out;
        };

        const expandedSegments: TranscriptSegment[] = [];
        for (const s of segments) {
          expandedSegments.push(...splitLongSegment(s, MAX_TAKE_DURATION));
        }

        const takeSegmentGroups: TranscriptSegment[][] = [];
        let currentGroup: TranscriptSegment[] = [];
        let groupStartTime = expandedSegments[0].start;

        for (const seg of expandedSegments) {
          const groupDuration = seg.end - groupStartTime;
          // Se adicionar este segmento excede 8s E já temos algo → novo take
          if (groupDuration > MAX_TAKE_DURATION && currentGroup.length > 0) {
            takeSegmentGroups.push([...currentGroup]);
            currentGroup = [seg];
            groupStartTime = seg.start;
          } else {
            currentGroup.push(seg);
          }
        }
        if (currentGroup.length > 0) takeSegmentGroups.push(currentGroup);

        // Atualiza takeCount pelo número real de grupos
        takeCount = Math.min(takeSegmentGroups.length, maxTakes);

        // Se temos mais grupos que maxTakes, compacta os últimos
        if (takeSegmentGroups.length > takeCount) {
          while (takeSegmentGroups.length > takeCount) {
            const last = takeSegmentGroups.pop()!;
            takeSegmentGroups[takeSegmentGroups.length - 1].push(...last);
          }
        }

        for (let i = 0; i < takeCount; i++) {
          const group = takeSegmentGroups[i];
          if (group) {
            // Junta os textos dos segmentos com espaço — preserva TODAS as palavras
            takeScripts[`take${i + 1}`] = group.map(s => s.text).join(" ").trim();
          } else {
            takeScripts[`take${i + 1}`] = "";
          }
        }

        await log(videoId, "narration_decision", "completed",
          `SPEAKING (Whisper segments) — ${takeCount} takes from ${segments.length} segments. ` +
          Object.entries(takeScripts).filter(([,v]) => v).map(([k, v]) =>
            `${k}=${v.split(/\s+/).length}w`).join(", "));

      } else {
        // ── FALLBACK: sem segmentos (cache antigo) — split por orações ──
        const maxWordsPerTake = 22;
        const clauseRegex = /[^.?!]+[.?!]*/g;
        const rawClauses = script.fullScript.match(clauseRegex) ?? [script.fullScript];
        const clauses = rawClauses.map(s => s.trim()).filter(s => s.length > 0);

        const takeGroups: string[][] = [];
        let currentGroupFb: string[] = [];
        let currentWords = 0;

        for (const clause of clauses) {
          const clauseWords = clause.split(/\s+/).length;
          if (currentWords + clauseWords > maxWordsPerTake && currentGroupFb.length > 0) {
            takeGroups.push([...currentGroupFb]);
            currentGroupFb = [clause];
            currentWords = clauseWords;
          } else {
            currentGroupFb.push(clause);
            currentWords += clauseWords;
          }
        }
        if (currentGroupFb.length > 0) takeGroups.push(currentGroupFb);

        if (takeGroups.length > takeCount) {
          takeCount = Math.min(takeGroups.length, maxTakes);
        }

        if (takeGroups.length <= takeCount) {
          for (let i = 0; i < takeCount; i++) {
            takeScripts[`take${i + 1}`] = takeGroups[i] ? takeGroups[i].join(" ").trim() : "";
          }
        } else {
          for (let i = 0; i < takeCount; i++) {
            if (i < takeCount - 1) {
              takeScripts[`take${i + 1}`] = takeGroups[i].join(" ").trim();
            } else {
              takeScripts[`take${i + 1}`] = takeGroups.slice(i).map(g => g.join(" ")).join(" ").trim();
            }
          }
        }

        await log(videoId, "narration_decision", "completed",
          `SPEAKING (fallback clause split) — ${takeCount} takes. ` +
          Object.entries(takeScripts).filter(([,v]) => v).map(([k, v]) =>
            `${k}=${v.split(/\s+/).length}w`).join(", "));
      }

      // ── Validação: verifica que TODAS as palavras do transcript estão nos takeScripts ──
      const originalWords = script.fullScript.split(/\s+/).filter(w => w.length > 0);
      const takeWords = Object.values(takeScripts).join(" ").split(/\s+/).filter(w => w.length > 0);
      if (takeWords.length < originalWords.length) {
        await log(videoId, "speech_validation", "failed",
          `WORDS LOST! Original: ${originalWords.length} words, Takes: ${takeWords.length} words. Diff: ${originalWords.length - takeWords.length} missing.`);
        // Força redistribuição: coloca TUDO nos takes disponíveis sem perder nada
        const allText = script.fullScript;
        const wordsPerTake = Math.ceil(originalWords.length / takeCount);
        for (let i = 0; i < takeCount; i++) {
          const start = i * wordsPerTake;
          const end = Math.min((i + 1) * wordsPerTake, originalWords.length);
          takeScripts[`take${i + 1}`] = originalWords.slice(start, end).join(" ");
        }
      }

      // Consolida: renumera take1..takeN para que TODOS sejam não-vazios e
      // fiquem contíguos. Antes a gente só shrinkava takeCount mas mantinha as
      // chaves originais — se take2 era vazio, o mapeamento ficava bugado e
      // "sumia" o texto de take3. Agora reordena e reatribui as chaves.
      const consolidated: Record<string, string> = {};
      let newIdx = 1;
      for (const key of Object.keys(takeScripts).sort((a, b) => {
        const na = parseInt(a.replace("take", ""), 10);
        const nb = parseInt(b.replace("take", ""), 10);
        return na - nb;
      })) {
        if (takeScripts[key] && takeScripts[key].length > 0) {
          consolidated[`take${newIdx}`] = takeScripts[key];
          newIdx++;
        }
      }
      const nonEmptyCount = newIdx - 1;
      if (nonEmptyCount < takeCount) {
        takeCount = nonEmptyCount;
      }

      script.takeScripts = consolidated;
      brief.narrationMode = "creator_speaking";
    } else {
      script.fullScript = "";
      const emptyScripts: Record<string, string> = {};
      for (let i = 0; i < takeCount; i++) emptyScripts[`take${i + 1}`] = "";
      script.takeScripts = emptyScripts;
      brief.narrationMode = "voiceover_narrator";
      await log(videoId, "narration_decision", "completed", "SILENT — Gemini said speech but Whisper returned empty");
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
    const characterName = video.character?.name ?? "the person";
    const veoPrompts = await generateVeoPrompts(
      product.name,
      brief,
      script.takeScripts,
      veoTemplate,
      characterName,
      referenceScene,
      takeCount,
      referenceVoiceStyle,
      referenceScenes.length > 0 ? referenceScenes : null
    );
    await log(videoId, "generate_veo_prompts", "completed", undefined, veoPrompts, Date.now() - t5);

    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { veoPrompts: veoPrompts as object },
    });

    // ── Step 6: Generate audio narration ──────────────────────────────────
    // TTS só é gerado para voiceover_narrator (narrador em off, sem lip-sync).
    // Para creator_speaking, o Veo3 gera a voz com lip-sync nativo — NÃO
    // devemos sobrepor com TTS externo.
    const t6 = Date.now();
    await setStep(videoId, "generating_audio");
    await log(videoId, "generate_audio", "started");

    const isVoiceover = brief.narrationMode === "voiceover_narrator";
    const hasScriptText = script.fullScript.trim().length > 0;
    const audioUrl = isVoiceover && hasScriptText
      ? await generateNarration(script.fullScript, voice, videoId)
      : null;
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { audioUrl } });
    await log(videoId, "generate_audio", "completed",
      audioUrl
        ? `Voiceover TTS generated (${script.fullScript.length} chars)`
        : brief.narrationMode === "creator_speaking"
          ? "Skipped — creator_speaking uses Veo native lip-sync (no external TTS)"
          : "Skipped (no speech/empty script)",
      undefined, Date.now() - t6);

    // ── Step 7: Submit Veo3 takes ──────────────────────────────────────────
    const t7 = Date.now();
    await setStep(videoId, "submitting_takes");
    await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "SUBMITTING_TAKES" } });
    await log(videoId, "submit_takes", "started");

    // Mantemos productImageUrl pra registrar no GenerationJob (histórico) mas
    // NÃO é mais input do Veo — usamos text-to-video pra ter uma pessoa nova
    // a cada geração.
    const productImageUrl = product.thumbnailUrl ?? product.detectedVideos[0]?.thumbnailUrl ?? "";

    await log(videoId, "submit_takes", "started",
      `Mode: transitionMode=${transitionMode}, hasNarration=${hasNarration}, will ${hasNarration && transitionMode === "continuous" ? "CHAIN sequentially" : "submit in PARALLEL (hard cuts)"}`);

    const accessToken = await getAccessToken();

    // Per-take duration: Veo image-to-video only supports [4, 6, 8] seconds.
    // Quando tem fala, SEMPRE usa 8s — encurtar corta palavras do script.
    // Quando é silencioso, pega o mais próximo de (refDuration / takeCount)
    // pra imitar o pacing dos cortes do vídeo de referência.
    const validDurations = [4, 6, 8] as const;
    let takeDuration: number;
    if (hasNarration) {
      takeDuration = 8;
    } else {
      const idealDuration = refDuration && refDuration > 0 && takeCount > 0
        ? refDuration / takeCount
        : 8;
      takeDuration = validDurations.reduce((best, d) =>
        Math.abs(d - idealDuration) < Math.abs(best - idealDuration) ? d : best
      , 8 as number);
    }

    const takePromptList: string[] = [];
    for (let i = 0; i < takeCount; i++) {
      takePromptList.push(veoPrompts[`take${i + 1}`] ?? `Vertical 9:16 smartphone UGC video. Take ${i + 1} — person interacts with ${product.name}.`);
    }

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
      const takeKey = `take${i + 1}`;
      const take = await prisma.ugcGeneratedTake.create({
        data: {
          videoId,
          userId,
          takeIndex: i,
          veoJobId: genJob.id,
          veoPrompt: prompt,
          script: script.takeScripts[takeKey] ?? "",
          referenceFrameUrl: referenceFrameUrls[takeKey] ?? null,
          editedImageUrl: perTakeEditedUrls[takeKey] || editedImageUrl || null,
          status: "QUEUED",
        },
      });

      // ── Submissão: continuous chain vs hard cuts ──
      // CONTINUOUS (fala): takes são SEQUENCIAIS — só submete take 1 agora.
      //   Takes 2+ ficam QUEUED e serão submetidos pelo polling quando o
      //   anterior completar (usando o último frame como input image).
      // HARD_CUTS ou SILENT: todos os takes submetidos em paralelo, cada um
      //   com seu próprio frame de referência (imita cortes secos).
      const useContinuousChain = hasNarration && transitionMode === "continuous";

      if (useContinuousChain && i > 0) {
        // Take de fala 2+: fica esperando — será submetido pelo polling
        await log(videoId, `submit_take_${takeKey}`, "started",
          `QUEUED — waiting for take ${i} to complete (sequential speech chain)`);
        continue;
      }

      // Escolhe a imagem certa pro take
      const take1Image = perTakeImages["take1"] || editedImage;
      let takeImage: { data: string; mimeType: string } | null;
      if (useContinuousChain) {
        takeImage = take1Image;
      } else {
        // HARD_CUTS ou SILENT: cada take usa seu próprio frame visual
        takeImage = perTakeImages[takeKey] || editedImage;
      }

      if (!takeImage) {
        // Sem imagem — cai pro modo text-to-video do Veo em vez de falhar o take.
        // O Veo gera uma pessoa nova baseada só no prompt. Identidade NÃO fica
        // consistente entre takes, mas é melhor que take vazio.
        await log(videoId, `submit_take_${takeKey}`, "started",
          `No reference image — falling back to text-to-video`);
      } else {
        await log(videoId, `submit_take_${takeKey}`, "started",
          `image-to-video mode (hasNarration=${hasNarration}, imageSize=${takeImage.data.length} bytes)`);
      }

      // Submit to Vertex AI
      try {
        const operationName = await submitVeoTake(prompt, modelId, accessToken, takeImage, takeDuration);
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
        if (errMsg.includes("usage guidelines") || errMsg.includes("violat")) {
          const rawFrameUrl = referenceFrameUrls[takeKey] ?? referenceFrameUrls["take1"];
          let retryImage: { data: string; mimeType: string } | null = null;
          if (rawFrameUrl) retryImage = await imageUrlToBase64(rawFrameUrl).catch(() => null);
          try {
            const operationName = await submitVeoTake(prompt, modelId, accessToken, retryImage, takeDuration);
            await prisma.generationJob.update({ where: { id: genJob.id }, data: { externalTaskId: operationName } });
            await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "PROCESSING" } });
          } catch (retryErr) {
            await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: String(retryErr) } });
            await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: String(retryErr) } });
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

  const MAX_RETRIES = 3; // Cada take pode ser retentado até 3x (total 4 tentativas, cada com frame diferente)

  // Check status of all GenerationJobs
  const accessToken = await getAccessToken().catch(() => null);
  let allCompleted = true;
  let failedCount = 0;
  let permanentlyFailed = 0; // takes que excederam max retries

  for (const take of video.takes) {
    if (take.status === "COMPLETED") continue;
    if (take.status === "FAILED") {
      // ── Auto-retry: se o take falhou mas ainda tem retries disponíveis, resubmete ──
      if (take.retryCount < MAX_RETRIES && accessToken) {
        console.log(`[pollAndAssemble] Take ${take.takeIndex} failed (retry ${take.retryCount}/${MAX_RETRIES}), auto-retrying...`);
        await log(videoId, `retry_take_${take.takeIndex}`, "started",
          `Retry ${take.retryCount + 1}/${MAX_RETRIES}: ${take.errorMessage ?? "unknown error"}`);

        // Determina a imagem para o retry
        // Se o erro foi de content policy ("usage guidelines"), tenta um frame
        // em posição diferente para evitar o mesmo falso positivo.
        let retryImage: { data: string; mimeType: string } | null = null;
        const sortedForRetry = [...video.takes].sort((a, b) => a.takeIndex - b.takeIndex);
        const isContentPolicyError = (take.errorMessage ?? "").includes("usage guidelines") || (take.errorMessage ?? "").includes("violat");

        if (take.takeIndex > 0) {
          const prevCompleted = sortedForRetry
            .filter(t => t.takeIndex < take.takeIndex && t.status === "COMPLETED")
            .pop();

          if (isContentPolicyError && prevCompleted?.videoUrl) {
            // Content policy rejection — try a different frame each retry
            // retry 0: 1.0s before end, retry 1: 2.0s before end
            const offsets = [1.0, 2.0, 3.0];
            const offset = offsets[Math.min(take.retryCount, offsets.length - 1)];
            console.log(`[pollAndAssemble] Content policy error, trying frame at ${offset}s before end of take ${prevCompleted.takeIndex}`);
            retryImage = await extractFrameAtOffset(prevCompleted.videoUrl, offset).catch(() => null);
          }

          // If not content policy or offset extraction failed, use normal lastFrame
          if (!retryImage) {
            if (prevCompleted?.lastFrameUrl) {
              retryImage = await imageUrlToBase64(prevCompleted.lastFrameUrl).catch(() => null);
            }
            if (!retryImage && prevCompleted?.videoUrl) {
              retryImage = await extractLastFrame(prevCompleted.videoUrl).catch(() => null);
            }
          }
        }
        // 3) Fallback: imagem editada (Nano Banana)
        if (!retryImage) {
          const editedUrl = take.editedImageUrl || sortedForRetry.find(t => t.takeIndex === 0)?.editedImageUrl;
          if (editedUrl) retryImage = await imageUrlToBase64(editedUrl).catch(() => null);
        }
        // 4) Fallback: referenceFrame raw
        if (!retryImage && take.referenceFrameUrl) {
          retryImage = await imageUrlToBase64(take.referenceFrameUrl).catch(() => null);
        }

        const retryPrompt = take.veoPrompt ?? `Vertical 9:16 smartphone UGC video. Take ${take.takeIndex + 1}.`;
        try {
          const newOp = await submitVeoTake(retryPrompt, "veo3-fast", accessToken!, retryImage);
          // Cria novo GenerationJob para o retry
          const newGenJob = await prisma.generationJob.create({
            data: {
              userId: video.userId,
              status: "PROCESSING",
              provider: "veo3-fast",
              inputImageUrl: take.referenceFrameUrl ?? "",
              promptText: retryPrompt,
              generatedPrompt: retryPrompt,
              aspectRatio: "RATIO_9_16",
              maxDuration: 8,
              externalTaskId: newOp,
              startedAt: new Date(),
            },
          });
          await prisma.ugcGeneratedTake.update({
            where: { id: take.id },
            data: {
              status: "PROCESSING",
              errorMessage: null,
              retryCount: take.retryCount + 1,
              veoJobId: newGenJob.id,
            },
          });
          await log(videoId, `retry_take_${take.takeIndex}`, "completed",
            `Resubmitted (attempt ${take.retryCount + 1})`);
          allCompleted = false;
          continue;
        } catch (retryErr) {
          console.error(`[pollAndAssemble] Auto-retry failed for take ${take.takeIndex}:`, retryErr);
          await log(videoId, `retry_take_${take.takeIndex}`, "failed", String(retryErr));
          // Mantém como FAILED, será retentado no próximo ciclo se ainda tiver retries
          if (take.retryCount + 1 >= MAX_RETRIES) {
            permanentlyFailed++;
          }
          failedCount++;
          continue;
        }
      }
      // Excedeu max retries — falha permanente
      permanentlyFailed++;
      failedCount++;
      continue;
    }
    if (!take.veoJobId || !accessToken) { allCompleted = false; continue; }

    const genJob = await prisma.generationJob.findUnique({ where: { id: take.veoJobId } });
    if (!genJob) { allCompleted = false; continue; }

    if (genJob.status === "COMPLETED" && genJob.outputVideoUrl) {
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "COMPLETED", videoUrl: genJob.outputVideoUrl },
      });
      // Se não tem lastFrameUrl, re-poll o Vertex para pegar o video original e extrair frame
      if (!take.lastFrameUrl && genJob.externalTaskId && accessToken) {
        console.log(`[pollAndAssemble] Take ${take.takeIndex} needs lastFrame, re-polling Vertex for raw video...`);
        try {
          const opName = genJob.externalTaskId;
          const mm = opName.match(/publishers\/google\/models\/([^/]+)\//);
          const mid = mm?.[1] ?? "veo-3.0-fast-generate-001";
          const fetchUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT ?? PROJECT_ID}/locations/us-central1/publishers/google/models/${mid}:fetchPredictOperation`;
          const opRes = await fetch(fetchUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ operationName: opName }),
          });
          const opData = (await opRes.json()) as { response?: { videos?: Array<{ uri?: string; bytesBase64Encoded?: string }> } };
          const entry = opData.response?.videos?.[0];
          let videoBuf: Buffer | null = null;
          if (entry?.bytesBase64Encoded) {
            videoBuf = Buffer.from(entry.bytesBase64Encoded, "base64");
          } else if (entry?.uri) {
            const ws = entry.uri.startsWith("gs://") ? entry.uri.slice(5) : entry.uri;
            const si = ws.indexOf("/");
            const bkt = ws.slice(0, si);
            const obj = encodeURIComponent(ws.slice(si + 1));
            const gcsRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${bkt}/o/${obj}?alt=media`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (gcsRes.ok) videoBuf = Buffer.from(await gcsRes.arrayBuffer());
          }
          if (videoBuf) {
            const lastFrame = await extractLastFrameFromBuffer(videoBuf);
            if (lastFrame) await persistLastFrame(lastFrame, take.id);
          }
        } catch (e) {
          console.error(`[pollAndAssemble] re-poll for lastFrame failed for take ${take.takeIndex}:`, e);
        }
      }
      continue;
    }
    if (genJob.status === "FAILED") {
      // Marca take como FAILED — o auto-retry será feito no próximo ciclo de polling
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "FAILED", errorMessage: genJob.errorMessage },
      });
      failedCount++;
      allCompleted = false; // Vai ser retentado no próximo ciclo
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
        const errMsg = opData.error.message ?? "";
        // Marca como FAILED — o auto-retry será feito no próximo ciclo
        await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: errMsg } });
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: errMsg } });
        failedCount++;
        allCompleted = false; // Vai ser retentado no próximo ciclo
        continue;
      }

      // Extract video
      const videoEntry = opData.response?.videos?.[0];
      const rawBase64 = videoEntry?.bytesBase64Encoded;
      const rawUri = videoEntry?.uri;

      let videoUrl: string;
      let videoBuffer: Buffer;
      if (rawBase64) {
        videoBuffer = Buffer.from(rawBase64, "base64");
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
        videoBuffer = Buffer.from(buf);
      } else {
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: "Veo não retornou vídeo" } });
        failedCount++;
        allCompleted = false;
        continue;
      }

      // Upload video to blob first (before any heavy processing to avoid OOM loops)
      const blob = await put(`ugc-take-${take.id}.mp4`, videoBuffer, { access: "public", contentType: "video/mp4", addRandomSuffix: false });
      videoUrl = blob.url;

      await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "COMPLETED", outputVideoUrl: videoUrl, completedAt: new Date() } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "COMPLETED", videoUrl } });

      // Extrai último frame para encadear o próximo take
      // (o trim de silêncio acontece no assembler, não aqui — evita OOM no polling)
      console.log(`[pollAndAssemble] Take ${take.takeIndex} completed, extracting last frame from buffer (${videoBuffer.byteLength} bytes)...`);
      const lastFrame = await extractLastFrameFromBuffer(videoBuffer).catch((e) => {
        console.error(`[pollAndAssemble] extractLastFrameFromBuffer failed for take ${take.takeIndex}:`, e);
        return null;
      });
      if (lastFrame) {
        await persistLastFrame(lastFrame, take.id).catch((e) =>
          console.error(`[pollAndAssemble] persistLastFrame failed for take ${take.takeIndex}:`, e));
      }
    } catch {
      allCompleted = false;
    }
  }

  // Se TODOS os takes falharam permanentemente (excederam retries), marca vídeo como FAILED
  if (permanentlyFailed === video.takes.length) {
    const failedReasons = video.takes
      .filter(t => t.errorMessage)
      .map(t => `Take ${t.takeIndex + 1}: ${t.errorMessage}`)
      .join("; ");
    await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: { status: "FAILED", errorMessage: `Todos os takes falharam após ${MAX_RETRIES} tentativas. ${failedReasons}` },
    });
    return { allDone: true, failedCount, status: "FAILED" };
  }

  // Se algum take falhou permanentemente mas outros completaram, marca vídeo como FAILED
  // (não pode faltar nenhuma parte)
  if (permanentlyFailed > 0) {
    const allOthersDone = video.takes.every(t =>
      t.status === "COMPLETED" || (t.status === "FAILED" && t.retryCount >= MAX_RETRIES)
    );
    if (allOthersDone) {
      const failedTakes = video.takes
        .filter(t => t.status === "FAILED")
        .map(t => `Take ${t.takeIndex + 1}: ${t.errorMessage ?? "erro desconhecido"}`)
        .join("; ");
      await prisma.ugcGeneratedVideo.update({
        where: { id: videoId },
        data: { status: "FAILED", errorMessage: `Takes falharam após retentativas: ${failedTakes}` },
      });
      return { allDone: true, failedCount, status: "FAILED" };
    }
  }

  // ── Encadeamento sequencial de takes de fala ──
  // Se há takes QUEUED (sem externalTaskId), verifica se o take anterior
  // completou. Se sim, extrai o último frame do vídeo anterior e submete
  // o próximo take com essa imagem como input.
  // Re-fetch takes pois o auto-retry acima pode ter alterado statuses
  const freshTakesForChain = await prisma.ugcGeneratedTake.findMany({ where: { videoId }, orderBy: { takeIndex: "asc" } });
  const sortedTakes = freshTakesForChain;
  for (const take of sortedTakes) {
    if (take.status !== "QUEUED") continue;

    const genJob = await prisma.generationJob.findUnique({ where: { id: take.veoJobId! } });
    if (!genJob || genJob.externalTaskId) continue; // Já foi submetido

    // Acha o take anterior
    const prevTake = sortedTakes.find(t => t.takeIndex === take.takeIndex - 1);
    if (!prevTake) {
      allCompleted = false;
      continue;
    }

    // Se o take anterior falhou, espera o auto-retry resolver (não pula — todas as partes são obrigatórias)
    if (prevTake.status === "FAILED") {
      // O auto-retry do loop acima vai cuidar de resubmeter o prevTake
      // Enquanto ele não completar, este take fica QUEUED esperando
      allCompleted = false;
      continue;
    }

    if (prevTake.status !== "COMPLETED" || !prevTake.videoUrl) {
      allCompleted = false;
      continue; // Anterior ainda não completou
    }

    // ── Busca ÚLTIMO FRAME do take anterior para encadear ──
    // OBRIGATÓRIO: cada take DEVE começar do último frame do anterior.
    // Se não conseguir extrair, NÃO usa fallback — espera próximo ciclo.
    let chainImage: { data: string; mimeType: string } | null = null;
    let chainSource = "";

    // 1) lastFrameUrl persistido no DB (melhor opção — já extraído e salvo como blob)
    if (prevTake.lastFrameUrl) {
      chainImage = await imageUrlToBase64(prevTake.lastFrameUrl).catch(() => null);
      if (chainImage) chainSource = `persisted lastFrameUrl from take ${prevTake.takeIndex}`;
    }

    // 2) Se não tem lastFrameUrl, tenta extrair ao vivo
    if (!chainImage && prevTake.videoUrl) {
      console.log(`[pollAndAssemble] No lastFrameUrl for take ${prevTake.takeIndex}, trying extractLastFrame...`);
      chainImage = await extractLastFrame(prevTake.videoUrl).catch(() => null);
      if (chainImage) {
        chainSource = `live-extracted from take ${prevTake.takeIndex} video`;
        // Salva para futuro uso
        await persistLastFrame(chainImage, prevTake.id).catch(() => {});
      }
    }

    // 3) Se blob deu 403, tenta re-poll do Vertex AI para pegar o video original
    if (!chainImage && prevTake.veoJobId && accessToken) {
      console.log(`[pollAndAssemble] Blob failed, re-polling Vertex for take ${prevTake.takeIndex} raw video...`);
      try {
        const prevGenJob = await prisma.generationJob.findUnique({ where: { id: prevTake.veoJobId } });
        if (prevGenJob?.externalTaskId) {
          const mm = prevGenJob.externalTaskId.match(/publishers\/google\/models\/([^/]+)\//);
          const mid = mm?.[1] ?? "veo-3.0-fast-generate-001";
          const fetchUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT ?? PROJECT_ID}/locations/us-central1/publishers/google/models/${mid}:fetchPredictOperation`;
          const opRes = await fetch(fetchUrl, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ operationName: prevGenJob.externalTaskId }),
          });
          const opData = (await opRes.json()) as { response?: { videos?: Array<{ uri?: string; bytesBase64Encoded?: string }> } };
          const entry = opData.response?.videos?.[0];
          let videoBuf: Buffer | null = null;
          if (entry?.bytesBase64Encoded) {
            videoBuf = Buffer.from(entry.bytesBase64Encoded, "base64");
          } else if (entry?.uri) {
            const ws = entry.uri.startsWith("gs://") ? entry.uri.slice(5) : entry.uri;
            const si = ws.indexOf("/");
            const bkt = ws.slice(0, si);
            const obj = encodeURIComponent(ws.slice(si + 1));
            const gcsRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${bkt}/o/${obj}?alt=media`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (gcsRes.ok) videoBuf = Buffer.from(await gcsRes.arrayBuffer());
          }
          if (videoBuf) {
            const lastFrame = await extractLastFrameFromBuffer(videoBuf);
            if (lastFrame) {
              chainImage = lastFrame;
              chainSource = `re-polled from Vertex AI for take ${prevTake.takeIndex}`;
              await persistLastFrame(lastFrame, prevTake.id).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error(`[pollAndAssemble] Vertex re-poll failed:`, e);
      }
    }

    // 4) Se NADA funcionou, NÃO usa Nano Banana — espera próximo polling cycle
    if (!chainImage) {
      console.warn(`[pollAndAssemble] Could not get last frame from take ${prevTake.takeIndex} for take ${take.takeIndex} — waiting for next poll cycle`);
      await log(videoId, `chain_take_${take.takeIndex}`, "started",
        `Waiting: could not extract last frame from take ${prevTake.takeIndex}. Will retry next cycle.`);
      allCompleted = false;
      break;
    }

    console.log(`[pollAndAssemble] Chain image for take ${take.takeIndex}: ${chainSource}`);

    // Submete o take com o último frame do anterior
    const takePrompt = take.veoPrompt ?? `Vertical 9:16 smartphone UGC video. Take ${take.takeIndex + 1}.`;
    try {
      const opName = await submitVeoTake(takePrompt, "veo3-fast", accessToken!, chainImage);
      await prisma.generationJob.update({ where: { id: genJob.id }, data: { externalTaskId: opName, status: "PROCESSING" } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "PROCESSING" } });
      await log(videoId, `chain_take_${take.takeIndex}`, "completed",
        `Submitted with LAST FRAME from take ${prevTake.takeIndex} (${chainSource}, ${chainImage.data.length} bytes base64)`);
      console.log(`[pollAndAssemble] Chained take ${take.takeIndex} submitted with ${chainSource}`);
    } catch (err) {
      console.error(`[pollAndAssemble] Failed to submit chained take ${take.takeIndex}:`, err);
      await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: String(err) } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: String(err) } });
      failedCount++;
    }
    allCompleted = false; // Acabamos de submeter um novo take
    break; // Só submete 1 por ciclo de polling
  }

  if (!allCompleted) {
    return { allDone: false, failedCount, status: "GENERATING_TAKES" };
  }

  // All done — verify ALL takes are COMPLETED before assembling (não pode faltar nenhuma parte)
  const freshTakes = await prisma.ugcGeneratedTake.findMany({
    where: { videoId },
    orderBy: { takeIndex: "asc" },
  });
  const allTakesCompleted = freshTakes.every(t => t.status === "COMPLETED");
  if (!allTakesCompleted) {
    // Algum take ainda não completou — não deve ter chegado aqui, mas safety check
    const missing = freshTakes.filter(t => t.status !== "COMPLETED");
    console.warn(`[pollAndAssemble] Assembly blocked: ${missing.length} takes not completed:`, missing.map(t => `take${t.takeIndex}=${t.status}`));
    return { allDone: false, failedCount, status: "GENERATING_TAKES" };
  }

  await prisma.ugcGeneratedVideo.update({ where: { id: videoId }, data: { status: "ASSEMBLING" } });
  await log(videoId, "assemble", "started", `All ${freshTakes.length} takes completed, assembling...`);

  try {
    const takeInfos = freshTakes
      .filter((t) => t.videoUrl)
      .map((t) => ({ url: t.videoUrl!, intendedScript: t.script ?? null }));

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
