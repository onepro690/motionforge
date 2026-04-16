import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    productsDetected,
    productsApproved,
    productsPending,
    videosGenerated,
    videosPending,
    videosApproved,
    videosFailed,
    videosToday,
    recentLogs,
  ] = await Promise.all([
    prisma.ugcTrendingProduct.count({ where: { userId } }),
    prisma.ugcTrendingProduct.count({ where: { userId, status: "APPROVED" } }),
    prisma.ugcTrendingProduct.count({ where: { userId, status: { in: ["DETECTED", "UNDER_REVIEW"] } } }),
    prisma.ugcGeneratedVideo.count({ where: { userId } }),
    prisma.ugcGeneratedVideo.count({ where: { userId, status: "AWAITING_REVIEW" } }),
    prisma.ugcGeneratedVideo.count({ where: { userId, status: { in: ["APPROVED", "COMPLETED"] } } }),
    prisma.ugcGeneratedVideo.count({ where: { userId, status: "FAILED" } }),
    prisma.ugcGeneratedVideo.count({ where: { userId, createdAt: { gte: today } } }),
    prisma.ugcPipelineLog.findMany({
      where: { video: { userId }, status: "failed" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { step: true, message: true, createdAt: true, videoId: true },
    }),
  ]);

  const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
  const dailyLimit = settings?.dailyVideoLimit ?? 10;

  return NextResponse.json({
    products: { detected: productsDetected, approved: productsApproved, pending: productsPending },
    videos: {
      total: videosGenerated,
      pendingReview: videosPending,
      approved: videosApproved,
      failed: videosFailed,
      today: videosToday,
      dailyLimit,
      remainingToday: Math.max(0, dailyLimit - videosToday),
    },
    recentErrors: recentLogs,
  });
}
