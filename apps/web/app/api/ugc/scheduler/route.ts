// Daily scheduler — called by Vercel Cron or manually
// Scrapes trending products and triggers generation up to daily limit

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { runVideoPipeline } from "@/lib/ugc/pipeline";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // Check if cron secret for automated runs
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  let userId: string;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    // Automated cron run — get first user (single-user setup)
    const user = await prisma.user.findFirst({ select: { id: true } });
    if (!user) return NextResponse.json({ error: "No users" }, { status: 404 });
    userId = user.id;
  } else {
    // Manual run by authenticated user
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    userId = session.user.id;
  }

  const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
  const dailyLimit = settings?.dailyVideoLimit ?? 10;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const videosToday = await prisma.ugcGeneratedVideo.count({ where: { userId, createdAt: { gte: today } } });

  if (videosToday >= dailyLimit) {
    return NextResponse.json({ message: "Limite diário já atingido", videosToday, dailyLimit });
  }

  const toGenerate = dailyLimit - videosToday;

  // Get approved products sorted by score
  const products = await prisma.ugcTrendingProduct.findMany({
    where: { userId, status: "APPROVED" },
    orderBy: { score: "desc" },
    take: toGenerate,
  });

  if (products.length === 0) {
    return NextResponse.json({ message: "Nenhum produto aprovado para gerar vídeos", videosToday, dailyLimit });
  }

  const created: string[] = [];

  for (let i = 0; i < Math.min(toGenerate, products.length); i++) {
    const product = products[i % products.length];
    const video = await prisma.ugcGeneratedVideo.create({
      data: {
        userId,
        productId: product.id,
        status: "DRAFT_GENERATED",
        title: `${product.name} - auto ${new Date().toISOString().split("T")[0]}`,
        currentStep: "queued",
      },
    });

    runVideoPipeline(video.id).catch((err) => {
      console.error(`[ugc/scheduler] Pipeline failed for ${video.id}:`, err);
    });

    created.push(video.id);
  }

  return NextResponse.json({ success: true, videosCreated: created.length, videoIds: created });
}
