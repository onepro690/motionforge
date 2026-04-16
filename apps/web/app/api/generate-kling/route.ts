import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

const schema = z.object({
  inputVideoUrl: z.string().url(),
  inputImageUrl: z.string().url(),
  prompt: z.string().optional().default(""),
  klingModel: z.enum(["kling-3.0", "kling-2.6"]).default("kling-3.0"),
  aspectRatio: z.enum(["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3"]).default("RATIO_9_16"),
  resolution: z.enum(["SD_480", "HD_720", "FHD_1080"]).default("HD_720"),
  backgroundMode: z.enum(["KEEP", "REMOVE", "BLUR", "REPLACE"]).default("KEEP"),
});

// Kling 3.0 modes
const RESOLUTION_MODE_MAP_V3: Record<string, string> = {
  SD_480: "std",
  HD_720: "std",
  FHD_1080: "pro",
};

// Kling 2.6 modes (different enum values)
const RESOLUTION_MODE_MAP_V26: Record<string, string> = {
  SD_480: "720p",
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

    const { inputVideoUrl, inputImageUrl, prompt, klingModel, aspectRatio, resolution, backgroundMode } = parsed.data;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "KIE_API_KEY not configured" }, { status: 500 });
    }

    // Map internal values to kie.ai API values
    const ASPECT_MAP: Record<string, string> = {
      RATIO_16_9: "16:9",
      RATIO_9_16: "9:16",
      RATIO_1_1:  "1:1",
      RATIO_4_3:  "4:3",
    };

    const BG_MAP: Record<string, string> = {
      KEEP:    "input_video",
      REMOVE:  "input_image",
      BLUR:    "input_video",
      REPLACE: "input_image",
    };

    const aspect_ratio = ASPECT_MAP[aspectRatio] ?? "9:16";
    const modelId = `${klingModel}/motion-control`;

    // Build input payload — Kling 2.6 and 3.0 have different field names/values
    const inputPayload: Record<string, unknown> = {
      input_urls:            [inputImageUrl],
      video_urls:            [inputVideoUrl],
      prompt:                prompt || "natural motion transfer, smooth and fluid movement, maintain avatar identity",
      character_orientation: "video",
      aspect_ratio,
    };

    if (klingModel === "kling-2.6") {
      inputPayload.mode = RESOLUTION_MODE_MAP_V26[resolution] ?? "720p";
      // background_source not supported in 2.6
    } else {
      inputPayload.mode = RESOLUTION_MODE_MAP_V3[resolution] ?? "std";
      inputPayload.background_source = BG_MAP[backgroundMode] ?? "input_video";
    }

    // Create task directly on kie.ai (no queue)
    const kieRes = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        input: inputPayload,
      }),
    });

    const kieData = (await kieRes.json()) as {
      code: number;
      msg?: string;
      message?: string;
      data?: { taskId: string };
    };

    if (!kieRes.ok || kieData.code !== 200) {
      console.error("[generate-kling] kie.ai task creation failed:", kieData);
      return NextResponse.json(
        { error: `Falha ao criar tarefa Kling: ${kieData.msg ?? kieData.message ?? JSON.stringify(kieData)}` },
        { status: 502 }
      );
    }

    const externalTaskId = kieData.data!.taskId;

    // Save job to DB
    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: "kling",
        inputVideoUrl,
        inputImageUrl,
        resolution,
        externalTaskId,
        startedAt: new Date(),
      },
    });

    return NextResponse.json({ id: job.id, status: job.status, externalTaskId });
  } catch (error) {
    console.error("[generate-kling] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
