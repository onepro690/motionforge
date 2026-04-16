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
import { ensureReferenceTranscript, fetchTikwmDetail, extractKeyFrames, analyzeReferenceVideoWithGemini, TranscriptSegment } from "./reference-video";
import { swapPersonWithAvatar, imageUrlToBase64 } from "./nano-banana";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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
    // Download video
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    await writeFile(videoPath, Buffer.from(await res.arrayBuffer()));

    // Get duration
    const duration: number = await new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (_err, data) => {
        resolve(data?.format?.duration ?? 0);
      });
    });
    if (duration <= 0) return null;

    // Extract frame at (duration - 0.1s) to get the very last usable frame
    const seekTime = Math.max(0, duration - 0.1);
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
    return {
      data: frameBuffer.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (err) {
    console.error("[pipeline] extractLastFrame error:", err);
    return null;
  } finally {
    await unlink(videoPath).catch(() => {});
    await unlink(framePath).catch(() => {});
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
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
  if (!characterImageUrl) {
    throw new Error("Nenhum personagem selecionado. Crie um personagem em Personagens antes de gerar.");
  }

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
    // Limite alto de takes — o pipeline decide quantos realmente precisa baseado
    // na análise do vídeo (cenas visuais + duração da fala). O max aqui é só
    // safety cap, não deve restringir o resultado normal.
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
        await log(videoId, "narration_detection", "completed",
          `Gemini says: narrationStyle=${geminiAnalysis.narrationStyle}, sceneCount=${geminiAnalysis.sceneCount}, hasNarration=${geminiAnalysis.hasNarration} → speech: ${hasNarration ? "SPEAKING" : "SILENT"}, takes: ${geminiSceneCount}`, {
          narrationStyle: geminiAnalysis.narrationStyle,
          narrationSummary: geminiAnalysis.narrationSummary,
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

        // Edita apenas os frames visuais distintos
        for (let fi = 0; fi < distinctFrameCount; fi++) {
          const hasPrevRef: boolean = fi > 0 && !!take1ResultUrl;
          await log(videoId, `nano_banana_frame${fi + 1}`, "started",
            hasPrevRef ? `frame ${fi + 1} + avatar + take1 result → swap (3 images)` : `frame ${fi + 1} + avatar → swap (2 images)`);
          const edited: { url: string; mimeType: string } | null = await swapPersonWithAvatar(
            keyframes.frames[fi].url,
            characterImageUrl,
            hasPrevRef ? take1ResultUrl : null
          ).catch((e) => {
            console.error(`[pipeline] nano_banana frame${fi + 1} error:`, e);
            return null;
          });
          if (edited) {
            editedByFrame[fi] = await imageUrlToBase64(edited.url);
            editedUrlByFrame[fi] = edited.url;
            if (fi === 0) take1ResultUrl = edited.url;
            await log(videoId, `nano_banana_frame${fi + 1}`, "completed", edited.url);
          } else {
            const rawFrame = await imageUrlToBase64(keyframes.frames[fi].url);
            editedByFrame[fi] = rawFrame;
            editedUrlByFrame[fi] = null;
            await log(videoId, `nano_banana_frame${fi + 1}`, "failed",
              rawFrame ? `using raw frame: ${keyframes.frames[fi].url}` : "all image methods failed");
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
      await log(videoId, "nano_banana_edit", "started", "fallback — single thumbnail + avatar");
      const edited = await swapPersonWithAvatar(bestReference.thumbnailUrl, characterImageUrl).catch(() => null);
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
        const takeSegmentGroups: TranscriptSegment[][] = [];
        let currentGroup: TranscriptSegment[] = [];
        let groupStartTime = segments[0].start;

        for (const seg of segments) {
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

      // Remove takes vazios do final
      const nonEmptyKeys = Object.keys(takeScripts).filter(k => takeScripts[k].length > 0);
      if (nonEmptyKeys.length < takeCount) {
        takeCount = nonEmptyKeys.length;
      }

      script.takeScripts = takeScripts;
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
      takeCount
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

    const accessToken = await getAccessToken();

    // Per-take duration: Veo image-to-video only supports [4, 6, 8] seconds.
    // Pick the closest valid duration to (refDuration / takeCount).
    const validDurations = [4, 6, 8] as const;
    const idealDuration = refDuration && refDuration > 0 && takeCount > 0
      ? refDuration / takeCount
      : 8;
    const takeDuration = validDurations.reduce((best, d) =>
      Math.abs(d - idealDuration) < Math.abs(best - idealDuration) ? d : best
    , 8 as number);

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
          script: Object.values(script.takeScripts)[i] ?? "",
          referenceFrameUrl: referenceFrameUrls[takeKey] ?? null,
          editedImageUrl: perTakeEditedUrls[takeKey] || editedImageUrl || null,
          status: "QUEUED",
        },
      });

      // ── Submissão: speech vs silent ──
      // SPEECH: takes são SEQUENCIAIS — só submete take 1 agora.
      //   Takes 2+ ficam QUEUED e serão submetidos pelo polling quando o
      //   anterior completar (usando o último frame como input image).
      // SILENT: todos os takes são submetidos em paralelo.

      if (hasNarration && i > 0) {
        // Take de fala 2+: fica esperando — será submetido pelo polling
        await log(videoId, `submit_take_${takeKey}`, "started",
          `QUEUED — waiting for take ${i} to complete (sequential speech chain)`);
        continue;
      }

      // Escolhe a imagem certa pro take
      const take1Image = perTakeImages["take1"] || editedImage;
      let takeImage: { data: string; mimeType: string } | null;
      if (hasNarration) {
        takeImage = take1Image;
      } else {
        takeImage = perTakeImages[takeKey] || editedImage;
      }

      if (!takeImage) {
        await log(videoId, `submit_take_${takeKey}`, "failed",
          `No reference image available.`);
        await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: "No reference image" } });
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: "No reference image available" } });
        continue;
      }

      await log(videoId, `submit_take_${takeKey}`, "started",
        `image-to-video mode (hasNarration=${hasNarration}, imageSize=${takeImage.data.length} bytes)`);

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
        const errMsg = opData.error.message ?? "";
        // Se Veo rejeitou a imagem por "usage guidelines", tenta com frame raw de referência
        if (errMsg.includes("usage guidelines") || errMsg.includes("violat")) {
          console.warn(`[pollAndAssemble] Take ${take.takeIndex} image rejected by Veo, retrying with reference frame...`);
          try {
            const retryPrompt = take.veoPrompt ?? `Vertical 9:16 smartphone UGC video. Take ${take.takeIndex + 1}.`;
            // Tenta com o frame raw de referência — se este take não tem, usa o do take 0
            let retryImage: { data: string; mimeType: string } | null = null;
            const refUrl = take.referenceFrameUrl
              ?? video.takes.find((t) => t.takeIndex === 0)?.referenceFrameUrl;
            if (refUrl) {
              console.log(`[pollAndAssemble] Using reference frame for retry: ${refUrl.substring(0, 60)}...`);
              retryImage = await imageUrlToBase64(refUrl).catch(() => null);
            }
            const retryOp = await submitVeoTake(retryPrompt, "veo3-fast", accessToken!, retryImage);
            await prisma.generationJob.update({ where: { id: genJob.id }, data: { externalTaskId: retryOp, status: "PROCESSING", errorMessage: null } });
            await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "PROCESSING", errorMessage: null } });
            allCompleted = false;
            continue;
          } catch (retryErr) {
            console.error(`[pollAndAssemble] Retry also failed:`, retryErr);
          }
        }
        await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: errMsg } });
        await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: errMsg } });
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

  // ── Encadeamento sequencial de takes de fala ──
  // Se há takes QUEUED (sem externalTaskId), verifica se o take anterior
  // completou. Se sim, extrai o último frame do vídeo anterior e submete
  // o próximo take com essa imagem como input.
  const sortedTakes = [...video.takes].sort((a, b) => a.takeIndex - b.takeIndex);
  for (const take of sortedTakes) {
    if (take.status !== "QUEUED") continue;

    const genJob = await prisma.generationJob.findUnique({ where: { id: take.veoJobId! } });
    if (!genJob || genJob.externalTaskId) continue; // Já foi submetido

    // Acha o take anterior
    const prevTake = sortedTakes.find(t => t.takeIndex === take.takeIndex - 1);
    if (!prevTake || prevTake.status !== "COMPLETED" || !prevTake.videoUrl) {
      allCompleted = false;
      continue; // Anterior ainda não completou
    }

    // Extrai último frame do take anterior como input image
    console.log(`[pollAndAssemble] Extracting last frame from take ${prevTake.takeIndex} for take ${take.takeIndex}...`);
    let chainImage = await extractLastFrame(prevTake.videoUrl).catch((e) => {
      console.error(`[pollAndAssemble] extractLastFrame failed:`, e);
      return null;
    });

    // Fallback 1: extrai último frame do vídeo OUTPUT do take 0 (avatar correto)
    if (!chainImage) {
      const take0 = sortedTakes.find(t => t.takeIndex === 0);
      if (take0?.videoUrl) {
        console.log(`[pollAndAssemble] Fallback 1: extracting last frame from take 0 output video`);
        chainImage = await extractLastFrame(take0.videoUrl).catch((e) => {
          console.error(`[pollAndAssemble] Fallback 1 extractLastFrame from take 0 failed:`, e);
          return null;
        });
      }
    }

    // Fallback 2: usa a imagem editada pelo Nano Banana (avatar correto)
    if (!chainImage) {
      const editedUrl = sortedTakes.find(t => t.takeIndex === 0)?.editedImageUrl
        || take.editedImageUrl;
      if (editedUrl) {
        console.log(`[pollAndAssemble] Fallback 2: using Nano Banana edited image`);
        chainImage = await imageUrlToBase64(editedUrl).catch(() => null);
      }
    }

    if (!chainImage) {
      console.error(`[pollAndAssemble] No image available for chained take ${take.takeIndex}`);
      await prisma.generationJob.update({ where: { id: genJob.id }, data: { status: "FAILED", errorMessage: "No chain image from previous take" } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "FAILED", errorMessage: "Could not extract frame from previous take" } });
      failedCount++;
      continue;
    }

    // Submete o take com o último frame do anterior
    const takePrompt = take.veoPrompt ?? `Vertical 9:16 smartphone UGC video. Take ${take.takeIndex + 1}.`;
    try {
      const opName = await submitVeoTake(takePrompt, "veo3-fast", accessToken!, chainImage);
      await prisma.generationJob.update({ where: { id: genJob.id }, data: { externalTaskId: opName, status: "PROCESSING" } });
      await prisma.ugcGeneratedTake.update({ where: { id: take.id }, data: { status: "PROCESSING" } });
      console.log(`[pollAndAssemble] Chained take ${take.takeIndex} submitted with last frame from take ${prevTake.takeIndex}`);
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
