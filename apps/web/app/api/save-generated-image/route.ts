import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { z } from "zod";

const schema = z.object({
  imageUrl: z.string().url(),
  prompt: z.string().max(2000).default(""),
  aspectRatio: z.enum(["1:1", "9:16", "16:9", "3:4", "4:3"]).default("9:16"),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { imageUrl, prompt, aspectRatio } = parsed.data;

    // Map aspect ratio string to DB enum
    const aspectRatioMap: Record<string, "RATIO_16_9" | "RATIO_9_16" | "RATIO_1_1" | "RATIO_4_3"> = {
      "16:9": "RATIO_16_9",
      "9:16": "RATIO_9_16",
      "1:1":  "RATIO_1_1",
      "4:3":  "RATIO_4_3",
      "3:4":  "RATIO_4_3", // closest available
    };

    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "COMPLETED",
        provider: "nanobanana",
        inputImageUrl: imageUrl,
        outputThumbnailUrl: imageUrl,
        promptText: prompt || null,
        aspectRatio: aspectRatioMap[aspectRatio] ?? "RATIO_9_16",
        completedAt: new Date(),
      },
    });

    return NextResponse.json({ id: job.id }, { status: 201 });
  } catch (error) {
    console.error("[save-generated-image] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
