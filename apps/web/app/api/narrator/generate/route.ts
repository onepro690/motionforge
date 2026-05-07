import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { computeTakeCount, planNarratorSegments } from "@/lib/narrator/plan";
import { submitVeoTextOnly, getVertexAccessToken } from "@/lib/narrator/veo";
import { ffmpegProbeDuration } from "@/lib/narrator/assemble";
import type { NarratorJobState, NarratorSegmentState } from "@/lib/narrator/types";

export const maxDuration = 120;

const VOICES_BY_GENDER = {
  male:   { id: "onyx",  label: "Onyx (masculina, profunda)" },
  female: { id: "nova",  label: "Nova (feminina, jovem)" },
} as const;

const schema = z.object({
  copy: z.string().min(20).max(4000),
  gender: z.enum(["male", "female"]),
  vibe: z.string().max(200).optional(),
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

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Entrada inválida", details: parsed.error.errors }, { status: 400 });
    }
    const { copy, gender, vibe } = parsed.data;
    const voice = VOICES_BY_GENDER[gender].id;

    // 1. Cria job parent (status PROCESSING) — usamos o ID dele pra nomear blobs
    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: "narrator",
        inputImageUrl: "",
        promptText: copy,
        aspectRatio: "RATIO_9_16",
        maxDuration: 8,
        startedAt: new Date(),
      },
    });

    try {
      // 2. Gera TTS e mede duração real
      const { url: audioUrl, durationSeconds: narrationDuration } = await generateTtsToBlob(copy, voice, job.id);
      if (narrationDuration <= 0) throw new Error("Não foi possível medir a duração da narração");

      // 3. Calcula N takes e planeja segmentos
      const takeCount = computeTakeCount(narrationDuration);
      const segments = await planNarratorSegments({ copy, takeCount, vibe });

      // 4. Submete N Veos paralelos (text-only)
      const accessToken = await getVertexAccessToken();
      const submitResults = await Promise.allSettled(
        segments.map((seg) =>
          submitVeoTextOnly(buildVeoPrompt(seg.visualPrompt, vibe), accessToken)
        )
      );

      const segState: NarratorSegmentState[] = segments.map((seg, i) => {
        const r = submitResults[i];
        if (r.status === "fulfilled") {
          return {
            index: i,
            text: seg.text,
            visualPrompt: seg.visualPrompt,
            opName: r.value.opName,
            status: "PROCESSING",
            videoUrl: null,
            errorMessage: null,
          };
        }
        return {
          index: i,
          text: seg.text,
          visualPrompt: seg.visualPrompt,
          opName: null,
          status: "FAILED",
          videoUrl: null,
          errorMessage: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      });

      const state: NarratorJobState = {
        kind: "narrator-v1",
        copy,
        voice,
        gender,
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

function buildVeoPrompt(visualPrompt: string, vibe?: string): string {
  const styleSuffix = vibe?.trim() ? ` Style: ${vibe.trim()}.` : "";
  return [
    visualPrompt,
    "The audio track must be completely silent — no voice, no speech, no music.",
    "No people speaking on camera. No subtitles. No text overlays. No on-screen captions.",
    "Mystical astrology and tarot atmosphere: deep cosmic blacks, violet and indigo tones with gold accents, volumetric god rays, smoke particles, lens flares, anamorphic light streaks.",
    "Dynamic revealing camera movement throughout — fast push-in, snap zoom, orbiting camera, crane reveal, vertigo zoom. Never static.",
    `Vertical 9:16 framing, cinematic premium B-roll, sharp focus, dramatic high-contrast color grading, suspenseful and revelatory pacing.${styleSuffix}`,
  ].join(" ");
}
