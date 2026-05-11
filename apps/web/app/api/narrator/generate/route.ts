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
} from "@/lib/narrator/prompts";
import { detectLanguage } from "@/lib/narrator/language";
import type { NarratorJobState, NarratorSegmentState, NarratorAudioMode } from "@/lib/narrator/types";

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
  mixMode: z.enum(["avatar", "broll", "mixed"]).optional(),
});

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
    const hasAvatar = Boolean(avatarImageUrl);
    let mixMode: "avatar" | "broll" | "mixed" = parsed.data.mixMode ?? (hasAvatar ? "avatar" : "broll");
    if (!hasAvatar) mixMode = "broll";

    // audioMode resolution:
    //  - "broll" sem avatar → tts_overlay (legado)
    //  - "mixed" → veo_native nos takes avatar/cutout (lipsync), TTS por take
    //    nos broll. Tratado como "veo_native" no state mas com segment.audioOverlayUrl
    //    populado pros broll.
    //  - "avatar" respeita audioMode; default veo_native
    let audioMode: NarratorAudioMode;
    if (mixMode === "broll") {
      audioMode = "tts_overlay";
    } else if (mixMode === "mixed") {
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
      const takeCount = computeTakeCount(narrationDuration);
      type PlannedSegment = {
        text: string;
        visualPrompt: string;
        style: "avatar" | "broll" | "avatar_cutout";
        backgroundDescription?: string;
      };
      let segments: PlannedSegment[];
      if (mixMode === "mixed") {
        const mixed = await planMixedSegments({ copy, takeCount, language });
        segments = mixed.map((s) => ({
          text: s.text,
          visualPrompt: s.visualPrompt,
          style: s.style,
          backgroundDescription: s.backgroundDescription,
        }));
      } else if (mixMode === "avatar") {
        segments = planAvatarSegments(copy, takeCount).map((s) => ({
          text: s.text, visualPrompt: s.visualPrompt, style: "avatar" as const,
        }));
      } else {
        const broll = await planNarratorSegments({ copy, takeCount, vibe });
        segments = broll.map((s) => ({
          text: s.text, visualPrompt: s.visualPrompt, style: "broll" as const,
        }));
      }

      // 5. Submete Veos. Estratégia por estilo de cada segment:
      //    - avatar → submitVeoWithImage(foto original, prompt fala/silent)
      //    - broll  → submitVeoTextOnly(buildBrollPrompt)
      //    - avatar_cutout → Nano Banana edita foto (troca fundo) → Veo image-to-video
      const accessToken = await getVertexAccessToken();

      let avatarImage: VeoImageInput | null = null;
      if (hasAvatar) {
        avatarImage = await fetchImageForVeo(avatarImageUrl!);
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

      const submitResults = await Promise.allSettled(
        segments.map((seg, i) => {
          if (seg.style === "broll") {
            return submitVeoTextOnly(brollBuilder(seg.visualPrompt, 0), accessToken);
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
            style: seg.style,
            editedImageUrl,
            audioOverlayUrl,
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
          style: seg.style,
          editedImageUrl,
          audioOverlayUrl,
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
