import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { pollAndAssembleTakes } from "@/lib/ugc/pipeline";

export const maxDuration = 120;

// Serializa detectedVideos.views (BigInt) pra number pro JSON não explodir.
function serializeVideo<T extends { product?: { detectedVideos?: Array<{ views: bigint | number }> } | null } | null>(v: T): T {
  if (!v || !v.product?.detectedVideos) return v;
  return {
    ...v,
    product: {
      ...v.product,
      detectedVideos: v.product.detectedVideos.map((d) => ({ ...d, views: Number(d.views) })),
    },
  } as T;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id },
    include: {
      product: {
        select: {
          name: true,
          thumbnailUrl: true,
          category: true,
          detectedVideos: {
            orderBy: { views: "desc" },
            take: 1,
            select: { videoId: true, videoUrl: true, thumbnailUrl: true, creatorHandle: true, description: true, views: true },
          },
        },
      },
      takes: { orderBy: { takeIndex: "asc" } },
      logs: { orderBy: { createdAt: "asc" }, take: 50 },
      reviews: { orderBy: { reviewedAt: "desc" }, take: 3 },
      remakeRequests: { orderBy: { createdAt: "desc" }, take: 3 },
    },
  });

  if (!video || video.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If generating takes, try to advance pipeline
  if (video.status === "GENERATING_TAKES") {
    try {
      const pollResult = await pollAndAssembleTakes(id);
      // Return fresh data after poll
      const fresh = await prisma.ugcGeneratedVideo.findUnique({
        where: { id },
        include: {
          product: {
            select: {
              name: true,
              thumbnailUrl: true,
              category: true,
              detectedVideos: {
                orderBy: { views: "desc" },
                take: 1,
                select: { videoId: true, videoUrl: true, thumbnailUrl: true, creatorHandle: true, description: true, views: true },
              },
            },
          },
          takes: { orderBy: { takeIndex: "asc" } },
          logs: { orderBy: { createdAt: "asc" }, take: 50 },
          reviews: { orderBy: { reviewedAt: "desc" }, take: 3 },
          remakeRequests: { orderBy: { createdAt: "desc" }, take: 3 },
        },
      });
      return NextResponse.json({ ...serializeVideo(fresh), _pollResult: pollResult });
    } catch {
      // Return current state even if poll fails
    }
  }

  return NextResponse.json(serializeVideo(video));
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!video || video.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Cascade apaga takes/logs/reviews/remakeRequests via Prisma schema.
  await prisma.ugcGeneratedVideo.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
