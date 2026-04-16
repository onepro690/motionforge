import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

const SEEDANCE_MODEL_IDS: Record<string, string> = {
  "seedance-1.5": "bytedance/seedance-1.5-pro",
};

const schema = z.object({
  inputImageUrl: z.string().url(),
  generatedPrompt: z.string().min(10),
  aspectRatio: z.enum(["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3"]).default("RATIO_9_16"),
  resolution: z.enum(["SD_480", "HD_720", "FHD_1080"]).default("HD_720"),
  maxDuration: z.union([z.literal(4), z.literal(5), z.literal(8), z.literal(10), z.literal(12), z.literal(15)]).default(4),
  promptText: z.string().optional(),
  model: z.enum(["seedance-1.5"]).default("seedance-1.5"),
});

// Flatten the JSON prompt into natural language for SeedDance.
// Puts speech first (drives lipsync), then motion details, then appends
// the original user description so no detail is ever lost.
function flattenPrompt(generatedPrompt: string, userDescription?: string): { prompt: string; hasSpeech: boolean } {
  try {
    const json = JSON.parse(generatedPrompt) as Record<string, unknown>;
    const parts: string[] = [];

    const speech = json.speech ? String(json.speech).trim() : "";
    const lang = json.speech_language ? String(json.speech_language).trim() : "Brazilian Portuguese";
    if (speech) {
      // Put speech + lipsync directive at the very top — the model weights early tokens more
      parts.push(
        `The person is speaking in ${lang}, saying: "${speech}". ` +
        `PERFECT LIP SYNC: lips and jaw move in precise synchronization with every single syllable — ` +
        `natural mouth opening and closing, realistic dental visibility when speaking, ` +
        `no mouth glitching, no flickering lips, no lip twitching, no frozen mouth, no stutter artifacts.`
      );
    }

    if (json.motion_detail) parts.push(String(json.motion_detail));
    if (json.motion_type) parts.push(String(json.motion_type));
    if (json.style) parts.push(String(json.style));
    if (json.rhythm) parts.push(String(json.rhythm));
    if (json.facial_expression) parts.push(String(json.facial_expression));
    if (json.quality) {
      const qualityStr = String(json.quality);
      const cleaned = speech
        ? qualityStr
        : qualityStr.replace(/,?\s*when speaking:.*$/i, "").trim();
      if (cleaned) parts.push(cleaned);
    }

    // Append original user description to preserve any detail not captured in JSON fields
    if (userDescription && userDescription.trim()) {
      parts.push(userDescription.trim());
    }

    return { prompt: parts.filter(Boolean).join(". "), hasSpeech: !!speech };
  } catch {
    // Not JSON — use as-is but still append user description
    const base = generatedPrompt;
    const prompt = userDescription?.trim() ? `${base}. ${userDescription.trim()}` : base;
    return { prompt, hasSpeech: false };
  }
}

// Map our enums → kie.ai Seedance values
const ASPECT_RATIO_MAP: Record<string, string> = {
  RATIO_16_9: "16:9",
  RATIO_9_16: "9:16",
  RATIO_1_1: "1:1",
  RATIO_4_3: "4:3",
};

const RESOLUTION_MAP: Record<string, string> = {
  SD_480: "480p",
  HD_720: "720p",
  FHD_1080: "1080p",
};


export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.errors }, { status: 400 });
    }

    const { inputImageUrl, generatedPrompt, aspectRatio, resolution, maxDuration, promptText, model } = parsed.data;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "KIE_API_KEY not configured" }, { status: 500 });
    }

    const modelId = SEEDANCE_MODEL_IDS[model] ?? "bytedance/seedance-1.5-pro";

    const { prompt, hasSpeech } = flattenPrompt(generatedPrompt, promptText);

    const kieRes = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        input: {
          input_urls: [inputImageUrl],
          prompt,
          duration: String(maxDuration),
          aspect_ratio: ASPECT_RATIO_MAP[aspectRatio] ?? "9:16",
          resolution: RESOLUTION_MAP[resolution] ?? "720p",
          generate_audio: hasSpeech,
        },
      }),
    });

    const kieData = (await kieRes.json()) as {
      code: number;
      message?: string;
      data?: { taskId: string };
    };

    if (!kieRes.ok || kieData.code !== 200) {
      console.error("[animate] kie.ai task creation failed:", kieData);
      return NextResponse.json(
        { error: `Falha ao criar tarefa SeedDance: ${kieData.message ?? JSON.stringify(kieData)}` },
        { status: 502 }
      );
    }

    const externalTaskId = kieData.data!.taskId;

    // Save job to DB
    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: model,
        inputImageUrl,
        promptText: promptText ?? generatedPrompt,
        generatedPrompt,
        aspectRatio,
        resolution,
        maxDuration,
        externalTaskId,
        startedAt: new Date(),
      },
    });

    return NextResponse.json({ id: job.id, status: job.status, externalTaskId });
  } catch (error) {
    console.error("[animate] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
