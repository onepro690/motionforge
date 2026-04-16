// Trigger generation for one or more approved products
// Can be called manually by user or by the scheduler

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { runVideoPipeline } from "@/lib/ugc/pipeline";
import { z } from "zod";

// Precisa caber: LLM (analyze, brief, copy, veo prompts) + TTS + image fetch
// + getAccessToken + submitVeoTake ×3. ~60-120s típico. Bump pra 300 (limite).
export const maxDuration = 300;
export const runtime = "nodejs";

const schema = z.object({
  productIds: z.array(z.string()).optional(), // specific products to use
  count: z.number().int().min(1).max(10).default(1),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = session.user.id;

    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.message }, { status: 400 });
    }

    const { productIds, count } = parsed.data;

    // Check daily limit
    const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
    const dailyLimit = settings?.dailyVideoLimit ?? 50;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const videosToday = await prisma.ugcGeneratedVideo.count({ where: { userId, createdAt: { gte: today } } });

    if (videosToday >= dailyLimit) {
      return NextResponse.json({ error: `Limite diário de ${dailyLimit} vídeos atingido (${videosToday} hoje)` }, { status: 429 });
    }

    const remaining = dailyLimit - videosToday;
    const toGenerate = Math.min(count, remaining);

    // Get approved products (includes USED_FOR_GENERATION for re-generation)
    let approvedProducts = await prisma.ugcTrendingProduct.findMany({
      where: {
        userId,
        status: { in: ["APPROVED", "USED_FOR_GENERATION"] },
        ...(productIds?.length ? { id: { in: productIds } } : {}),
      },
      orderBy: { score: "desc" },
      take: toGenerate,
    });

    if (approvedProducts.length === 0) {
      if (settings?.autoMode) {
        approvedProducts = await prisma.ugcTrendingProduct.findMany({
          where: { userId, status: "DETECTED" },
          orderBy: { score: "desc" },
          take: toGenerate,
        });
      }
      if (approvedProducts.length === 0) {
        return NextResponse.json({
          error: "Nenhum produto aprovado encontrado. Aprove produtos em alta primeiro.",
          debug: { userId, productIds, videosToday, dailyLimit },
        }, { status: 400 });
      }
    }

    const createdVideos: string[] = [];

    for (let i = 0; i < Math.min(toGenerate, approvedProducts.length); i++) {
      const product = approvedProducts[i % approvedProducts.length];

      const video = await prisma.ugcGeneratedVideo.create({
        data: {
          userId,
          productId: product.id,
          status: "DRAFT_GENERATED",
          title: `${product.name} - v${Date.now()}`,
          currentStep: "queued",
        },
      });

      const videoIdForBg = video.id;
      after(async () => {
        try {
          await runVideoPipeline(videoIdForBg);
        } catch (err) {
          console.error(`[ugc/generate] Pipeline failed for video ${videoIdForBg}:`, err);
          await prisma.ugcGeneratedVideo.update({
            where: { id: videoIdForBg },
            data: {
              status: "FAILED",
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          }).catch(() => null);
        }
      });

      createdVideos.push(video.id);
    }

    return NextResponse.json({
      success: true,
      videosCreated: createdVideos.length,
      videoIds: createdVideos,
    });
  } catch (err) {
    console.error("[ugc/generate] Unhandled error:", err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Erro interno ao gerar vídeo",
    }, { status: 500 });
  }
}
