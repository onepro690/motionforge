import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;

  const where = {
    userId,
    ...(status ? { status: status as "DETECTED" | "APPROVED" | "REJECTED" } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.ugcTrendingProduct.findMany({
      where,
      orderBy: { score: "desc" },
      take: limit,
      skip,
      include: {
        _count: { select: { detectedVideos: true, generatedVideos: true } },
        detectedVideos: { take: 4, select: { thumbnailUrl: true, videoId: true, creatorHandle: true, views: true } },
      },
    }),
    prisma.ugcTrendingProduct.count({ where }),
  ]);

  // Serialize BigInt fields to numbers for JSON
  const serialized = products.map((p) => ({
    ...p,
    totalViews: Number(p.totalViews),
    totalLikes: Number(p.totalLikes),
    totalShares: Number(p.totalShares),
    totalComments: Number(p.totalComments),
    detectedVideos: p.detectedVideos.map((v) => ({
      ...v,
      views: Number(v.views),
    })),
  }));

  return NextResponse.json({ products: serialized, total, page, limit, pages: Math.ceil(total / limit) });
}
