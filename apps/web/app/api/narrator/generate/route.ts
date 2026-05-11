import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { computeTakeCount, planNarratorSegments, planAvatarSegments } from "@/lib/narrator/plan";
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
});

async function generateTtsToBlob(script: string, voice: string, jobId: string): Promise<{ url: string; durationSeconds: number }> {
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

  const blob = await put(`narrator-tts-${jobId}.mp3`, buffer, {
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

    // Sem avatar → modo legado: TTS overlay obrigatório.
    // Com avatar → respeita audioMode; default veo_native.
    const hasAvatar = Boolean(avatarImageUrl);
    const audioMode: NarratorAudioMode = hasAvatar
      ? (parsed.data.audioMode ?? "veo_native")
      : "tts_overlay";

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

      // 4. Calcula N takes e planeja segmentos
      const takeCount = computeTakeCount(narrationDuration);
      const segments = hasAvatar
        ? planAvatarSegments(copy, takeCount)
        : await planNarratorSegments({ copy, takeCount, vibe });

      // 5. Submete Veos. Estratégia depende do modo:
      //    - Avatar: submete SÓ take 0 com a foto original. Takes 1+ ficam QUEUED
      //      e o polling submete cada um com o last-frame do anterior, eliminando
      //      cortes secos (last-frame chaining).
      //    - B-roll (sem avatar): submete todos em paralelo (comportamento legado).
      const accessToken = await getVertexAccessToken();

      let avatarImage: VeoImageInput | null = null;
      if (hasAvatar) {
        avatarImage = await fetchImageForVeo(avatarImageUrl!);
      }

      // Todos os takes em paralelo. No modo avatar, cada take começa da MESMA
      // foto original — zero drift de identidade/cor. Cortes secos visuais
      // são suavizados depois via crossfade no assembly.
      const submitResults = await Promise.allSettled(
        segments.map((seg) => {
          if (hasAvatar && avatarImage) {
            const prompt =
              audioMode === "veo_native"
                ? buildAvatarSpeechPrompt(seg.text, gender, vibe, 0, language)
                : buildAvatarSilentPrompt(vibe, 0);
            return submitVeoWithImage(prompt, avatarImage, accessToken);
          }
          return submitVeoTextOnly(buildBrollPrompt(seg.visualPrompt, vibe, 0), accessToken);
        }),
      );

      const segState: NarratorSegmentState[] = segments.map((seg, i) => {
        const r = submitResults[i];
        if (r.status === "fulfilled") {
          return {
            index: i,
            text: seg.text,
            visualPrompt: seg.visualPrompt,
            opName: r.value.opName,
            status: "PROCESSING" as const,
            videoUrl: null,
            errorMessage: null,
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
