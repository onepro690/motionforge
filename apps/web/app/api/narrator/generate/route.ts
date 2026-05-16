import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { computeTakeCount, planNarratorSegments, planAvatarSegments, planMixedSegments } from "@/lib/narrator/plan";
import { parseScript, speakerCounts } from "@/lib/narrator/script-parser";
import type { ScriptShot } from "@/lib/narrator/script-types";
import { swapAvatarBackground } from "@/lib/narrator/cutout";
import {
  submitVeoTextOnly,
  submitVeoWithImage,
  fetchImageForVeo,
  getVertexAccessToken,
  type VeoImageInput,
} from "@/lib/narrator/veo";
import { ffmpegProbeDuration } from "@/lib/narrator/assemble";
import {
  buildAvatarSpeechPrompt,
  buildAvatarSilentPrompt,
  buildBrollPrompt,
  buildBrollPromptGeneric,
  buildScriptShotPrompt,
} from "@/lib/narrator/prompts";
import { detectLanguage } from "@/lib/narrator/language";
import { settledPool, withQuotaRetry, VEO_SUBMIT_CONCURRENCY } from "@/lib/narrator/concurrency";
import type { NarratorJobState, NarratorSegmentState, NarratorAudioMode, NarratorSpeaker } from "@/lib/narrator/types";

export const maxDuration = 120;

const VOICES_BY_GENDER = {
  male:   { id: "onyx",  label: "Onyx (masculina, profunda)" },
  female: { id: "nova",  label: "Nova (feminina, jovem)" },
} as const;

const schema = z.object({
  copy: z.string().min(20).max(4000),
  gender: z.enum(["male", "female"]),
  vibe: z.string().max(200).optional(),
  avatarImageUrl: z.string().url().optional(),
  audioMode: z.enum(["veo_native", "tts_overlay"]).optional(),
  mixMode: z.enum(["avatar", "broll", "mixed", "conversation"]).optional(),
  // Modo conversation: gênero de cada pessoa da foto.
  genderA: z.enum(["male", "female"]).optional(),
  genderB: z.enum(["male", "female"]).optional(),
});

// GPT-4o-mini Vision: descreve cada pessoa de uma foto com 2 avatares.
// Usado nos retries (attempt >= 2) pra desambiguar quem fala quando o prompt
// posicional left/right não isolou bem. Falha não-fatal — null retorna.
async function describeTwoPeople(imageUrl: string): Promise<{ left: string; right: string } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You describe two people in a photo. Return JSON: {\"left\": \"...\", \"right\": \"...\"}. Each description is 6-12 words covering distinctive features (hair color/style, top clothing color, glasses, beard, age range, gender). No names. Pure visual differentiators. If you only see one person or cannot tell, return empty strings.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe the LEFT person and the RIGHT person in this image." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as { left?: string; right?: string };
    const left = parsed.left?.trim() ?? "";
    const right = parsed.right?.trim() ?? "";
    if (!left || !right) return null;
    return { left, right };
  } catch (err) {
    console.warn("[narrator] describeTwoPeople falhou:", err);
    return null;
  }
}

async function generateTtsToBlob(script: string, voice: string, jobId: string, suffix = ""): Promise<{ url: string; durationSeconds: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "tts-1-hd",
      input: script,
      voice,
      response_format: "mp3",
      speed: 1.0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS error: ${res.status} ${err.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());

  // Mede duração local antes de uploadar
  const tmp = join("/tmp", `narrator-tts-${randomBytes(6).toString("hex")}.mp3`);
  await writeFile(tmp, buffer);
  const durationSeconds = await ffmpegProbeDuration(tmp);
  await unlink(tmp).catch(() => {});

  const blob = await put(`narrator-tts-${jobId}${suffix}.mp3`, buffer, {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return { url: blob.url, durationSeconds };
}

// Estimativa de duração quando não geramos TTS (modo Veo nativo). pt-BR fala
// ≈2.8 palavras/segundo em ritmo conversacional natural.
function estimateNarrationSeconds(copy: string): number {
  const words = copy.split(/\s+/).filter(Boolean).length;
  return Math.max(2, words / 2.8);
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Entrada inválida", details: parsed.error.errors }, { status: 400 });
    }
    const { copy, gender, vibe, avatarImageUrl } = parsed.data;
    const voice = VOICES_BY_GENDER[gender].id;

    // mixMode resolution:
    //  - "avatar" só faz sentido com avatar — força "avatar" se há foto, senão "broll"
    //  - "broll" sempre sem avatar
    //  - "mixed" requer avatar (cutout precisa da foto); senão cai pra "broll"
    //  - "conversation" requer avatar (foto com 2 pessoas) + tags [A]/[B] na copy
    const hasAvatar = Boolean(avatarImageUrl);
    let mixMode: "avatar" | "broll" | "mixed" | "conversation" = parsed.data.mixMode ?? (hasAvatar ? "avatar" : "broll");
    if (!hasAvatar) mixMode = "broll";

    // Validação básica de avatar pro modo conversation. A validação rica do
    // roteiro (presença de A e B, número de shots) acontece após parseScript
    // dentro do try/catch porque depende de chamada LLM.
    if (mixMode === "conversation" && !hasAvatar) {
      return NextResponse.json({
        error: "Modo Roteiro precisa de uma foto com 2 pessoas.",
      }, { status: 400 });
    }

    const genderA = parsed.data.genderA ?? gender;
    const genderB = parsed.data.genderB ?? (gender === "male" ? "female" : "male");

    // audioMode resolution:
    //  - "broll" sem avatar → tts_overlay (legado)
    //  - "mixed" → veo_native nos takes avatar/cutout (lipsync), TTS por take
    //    nos broll. Tratado como "veo_native" no state mas com segment.audioOverlayUrl
    //    populado pros broll.
    //  - "conversation" → veo_native sempre (TTS por cima de 2 bocas não dá pra lip-sync)
    //  - "avatar" respeita audioMode; default veo_native
    let audioMode: NarratorAudioMode;
    if (mixMode === "broll") {
      audioMode = "tts_overlay";
    } else if (mixMode === "mixed" || mixMode === "conversation") {
      audioMode = "veo_native";
    } else {
      audioMode = parsed.data.audioMode ?? "veo_native";
    }

    // 1. Cria job parent (status PROCESSING) — usamos o ID dele pra nomear blobs
    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: "narrator",
        inputImageUrl: avatarImageUrl ?? "",
        promptText: copy,
        aspectRatio: "RATIO_9_16",
        maxDuration: 8,
        startedAt: new Date(),
      },
    });

    try {
      // 2. Detecta idioma da copy (pt-BR, en, es) — aplicado nos prompts do Veo.
      const language = detectLanguage(copy);

      // 3. Duração da narração
      //    - Modo TTS overlay (com ou sem avatar): gera TTS pra medir e usar como áudio.
      //    - Modo Veo nativo: estima via word count (não há TTS).
      let narrationDuration: number;
      let audioUrl: string | null = null;
      if (audioMode === "tts_overlay") {
        const tts = await generateTtsToBlob(copy, voice, job.id);
        if (tts.durationSeconds <= 0) throw new Error("Não foi possível medir a duração da narração");
        narrationDuration = tts.durationSeconds;
        audioUrl = tts.url;
      } else {
        narrationDuration = estimateNarrationSeconds(copy);
      }

      // 4. Calcula N takes e planeja segmentos. mixMode dita o planejador:
      //    - "avatar" → planAvatarSegments (split simples; todos style=avatar)
      //    - "broll"  → planNarratorSegments (B-roll cinematográfico)
      //    - "mixed"  → planMixedSegments (LLM classifica cada segment)
      //    - "conversation" → planConversationSegments (parse tags A/B,
      //      sub-split de turnos longos). takeCount vem do parser, não de
      //      narrationDuration.
      type PlannedSegment = {
        text: string;
        visualPrompt: string;
        style: "avatar" | "broll" | "avatar_cutout" | "conversation";
        backgroundDescription?: string;
        speaker?: NarratorSpeaker;
        // Campos extras do parser de roteiro (mixMode='conversation')
        shotKind?: "dialog" | "reaction" | "joint_action";
        visualAction?: string;
        sceneContext?: string;
        cameraDirection?: string;
      };
      let segments: PlannedSegment[];
      let takeCount: number;
      let scriptShots: ScriptShot[] = [];
      if (mixMode === "conversation") {
        // LLM lê o roteiro estruturado (cenas, falas com reação, ações silenciosas,
        // cortes de câmera) e devolve shots ricos pra alimentar cada take Veo.
        scriptShots = await parseScript(copy);
        const { a, b } = speakerCounts(scriptShots);
        if (scriptShots.length === 0) {
          throw new Error("Roteiro não produziu nenhum shot válido. Verifique se há ao menos uma fala marcada com [A] ou [B].");
        }
        if (a === 0 || b === 0) {
          throw new Error("Roteiro precisa de ao menos uma fala de [A] E uma fala de [B] pra modo conversa.");
        }
        segments = scriptShots.map((shot) => ({
          text: shot.spokenText,
          visualPrompt: "",
          style: "conversation" as const,
          speaker: shot.speaker ?? undefined,
          shotKind: shot.kind,
          visualAction: shot.visualAction,
          sceneContext: shot.sceneContext,
          cameraDirection: shot.cameraDirection,
        }));
        takeCount = segments.length;
        // Estima duração: dialogs por word count, reactions ~3s fixo (silent action).
        const dialogWords = scriptShots
          .filter((s) => s.kind === "dialog")
          .reduce((acc, s) => acc + s.spokenText.split(/\s+/).filter(Boolean).length, 0);
        const silentShots = scriptShots.filter((s) => s.kind !== "dialog").length;
        narrationDuration = Math.max(2, dialogWords / 2.8 + silentShots * 3);
      } else if (mixMode === "mixed") {
        takeCount = computeTakeCount(narrationDuration);
        const mixed = await planMixedSegments({ copy, takeCount, language });
        segments = mixed.map((s) => ({
          text: s.text,
          visualPrompt: s.visualPrompt,
          style: s.style,
          backgroundDescription: s.backgroundDescription,
        }));
      } else if (mixMode === "avatar") {
        takeCount = computeTakeCount(narrationDuration);
        segments = planAvatarSegments(copy, takeCount).map((s) => ({
          text: s.text, visualPrompt: s.visualPrompt, style: "avatar" as const,
        }));
      } else {
        takeCount = computeTakeCount(narrationDuration);
        const broll = await planNarratorSegments({ copy, takeCount, vibe });
        segments = broll.map((s) => ({
          text: s.text, visualPrompt: s.visualPrompt, style: "broll" as const,
        }));
      }

      // 5. Submete Veos. Estratégia por estilo de cada segment:
      //    - avatar → submitVeoWithImage(foto original, prompt fala/silent)
      //    - broll  → submitVeoTextOnly(buildBrollPrompt)
      //    - avatar_cutout → Nano Banana edita foto (troca fundo) → Veo image-to-video
      //    - conversation → submitVeoWithImage(MESMA foto, prompt fala isolada)
      const accessToken = await getVertexAccessToken();

      let avatarImage: VeoImageInput | null = null;
      if (hasAvatar) {
        avatarImage = await fetchImageForVeo(avatarImageUrl!);
      }

      // Modo conversation: gera descritores das 2 pessoas (best-effort).
      // Usados pelos prompts no attempt >= 2 dos retries quando o prompt
      // posicional left/right não isolou bem o falante.
      let personDescriptorA: string | undefined;
      let personDescriptorB: string | undefined;
      if (mixMode === "conversation" && avatarImageUrl) {
        const desc = await describeTwoPeople(avatarImageUrl);
        if (desc) {
          personDescriptorA = desc.left;
          personDescriptorB = desc.right;
        }
      }

      // PREPS PARALELOS:
      //  1. Pra cutouts: Nano Banana edita foto (troca fundo).
      //  2. Pra broll em mixed mode: gera TTS específico daquele trecho.
      const cutoutImages: Record<number, VeoImageInput | null> = {};
      const brollTtsUrls: Record<number, string | null> = {};

      await Promise.all(
        segments.flatMap((seg, i) => {
          const tasks: Promise<void>[] = [];

          // 1. Nano Banana cutout
          if (seg.style === "avatar_cutout" && avatarImageUrl) {
            tasks.push((async () => {
              const editedUrl = await swapAvatarBackground(
                avatarImageUrl,
                seg.backgroundDescription || "soft cinematic indoor scene with natural light",
                job.id,
                i,
              );
              if (editedUrl) {
                try {
                  cutoutImages[i] = await fetchImageForVeo(editedUrl);
                  (seg as PlannedSegment & { editedImageUrl?: string }).editedImageUrl = editedUrl;
                } catch {
                  cutoutImages[i] = null;
                }
              }
            })());
          }

          // 2. TTS por segmento em mixed mode (só broll precisa — avatar/cutout
          //    têm áudio Veo nativo com lipsync).
          if (mixMode === "mixed" && seg.style === "broll" && seg.text.trim()) {
            tasks.push((async () => {
              try {
                const tts = await generateTtsToBlob(seg.text, voice, job.id, `-seg-${i}`);
                brollTtsUrls[i] = tts.url;
              } catch (err) {
                console.error(`[narrator] TTS por segmento ${i} falhou:`, err);
                brollTtsUrls[i] = null;
              }
            })());
          }

          return tasks;
        }),
      );

      // Helper: escolhe builder de prompt B-roll. Em mixed, usa o genérico
      // (ilustra literalmente sem injetar estética hardcoded).
      const brollBuilder = mixMode === "mixed" ? buildBrollPromptGeneric : (vp: string, attempt: number) => buildBrollPrompt(vp, vibe, attempt);

      // Submete com cap de concorrência + retry exponencial em erro de quota
      // do Veo (long_running_online_prediction_requests_per_base_model).
      const submitResults = await settledPool(segments, VEO_SUBMIT_CONCURRENCY, (seg, i) =>
        withQuotaRetry(() => {
          if (seg.style === "broll") {
            return submitVeoTextOnly(brollBuilder(seg.visualPrompt, 0), accessToken);
          }
          // conversation: image-to-video com a MESMA foto + shot rico do parser
          // (dialog com lip-sync isolado, reaction silenciosa, joint_action).
          if (seg.style === "conversation") {
            if (!avatarImage) {
              return submitVeoTextOnly(brollBuilder("Two people having a calm conversation in soft ambient indoor light.", 0), accessToken);
            }
            // Reconstrói o ScriptShot a partir do segment armazenado.
            const shot: ScriptShot = {
              kind: seg.shotKind ?? "dialog",
              speaker: seg.speaker ?? null,
              spokenText: seg.text,
              visualAction: seg.visualAction ?? "",
              sceneContext: seg.sceneContext ?? "",
              cameraDirection: seg.cameraDirection ?? "",
            };
            const prompt = buildScriptShotPrompt({
              shot,
              genderA,
              genderB,
              language,
              attempt: 0,
              personDescriptorA,
              personDescriptorB,
            });
            return submitVeoWithImage(prompt, avatarImage, accessToken);
          }
          // avatar OR avatar_cutout — image-to-video
          const image = seg.style === "avatar_cutout" ? cutoutImages[i] ?? avatarImage : avatarImage;
          if (!image) {
            return submitVeoTextOnly(brollBuilder(seg.visualPrompt, 0), accessToken);
          }
          const prompt =
            audioMode === "veo_native"
              ? buildAvatarSpeechPrompt(seg.text, gender, vibe, 0, language)
              : buildAvatarSilentPrompt(vibe, 0);
          return submitVeoWithImage(prompt, image, accessToken);
        }),
      );

      const submittedAt = Date.now();
      const segState: NarratorSegmentState[] = segments.map((seg, i) => {
        const r = submitResults[i];
        const editedImageUrl = (seg as PlannedSegment & { editedImageUrl?: string }).editedImageUrl ?? null;
        const audioOverlayUrl = brollTtsUrls[i] ?? null;
        const baseExtra = {
          style: seg.style,
          editedImageUrl,
          audioOverlayUrl,
          speaker: seg.speaker,
          shotKind: seg.shotKind,
          visualAction: seg.visualAction,
          sceneContext: seg.sceneContext,
          cameraDirection: seg.cameraDirection,
        };
        if (r.status === "fulfilled") {
          return {
            index: i,
            text: seg.text,
            visualPrompt: seg.visualPrompt,
            opName: r.value.opName,
            status: "PROCESSING" as const,
            videoUrl: null,
            errorMessage: null,
            lastSubmittedAt: submittedAt,
            ...baseExtra,
          };
        }
        return {
          index: i,
          text: seg.text,
          visualPrompt: seg.visualPrompt,
          opName: null,
          status: "FAILED" as const,
          videoUrl: null,
          errorMessage: r.reason instanceof Error ? r.reason.message : String(r.reason),
          ...baseExtra,
        };
      });

      const state: NarratorJobState = {
        kind: "narrator-v1",
        copy,
        voice,
        gender,
        avatarImageUrl: avatarImageUrl ?? null,
        audioMode,
        language,
        mixMode,
        narrationAudioUrl: audioUrl,
        narrationDurationSeconds: narrationDuration,
        segments: segState,
        finalVideoUrl: null,
        finalErrorMessage: null,
        ...(mixMode === "conversation" ? {
          genderA,
          genderB,
          personDescriptorA,
          personDescriptorB,
        } : {}),
      };

      await prisma.generationJob.update({
        where: { id: job.id },
        data: {
          generatedPrompt: JSON.stringify(state),
          maxDuration: Math.ceil(narrationDuration),
        },
      });

      return NextResponse.json({
        id: job.id,
        status: "PROCESSING",
        narrationDurationSeconds: narrationDuration,
        takeCount,
        audioMode,
        hasAvatar,
        mixMode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar narrador";
      await prisma.generationJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorMessage: msg, completedAt: new Date() },
      });
      throw err;
    }
  } catch (error) {
    console.error("[narrator/generate] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
