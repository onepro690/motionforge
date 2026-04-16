import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";

const patchSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "SAVED_FOR_LATER", "UNDER_REVIEW"]).optional(),
  rejectionReason: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
  productUrl: z.string().url().optional().or(z.literal("")),
  trendSummary: z.string().max(1000).optional(),
  category: z.string().max(100).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const product = await prisma.ugcTrendingProduct.findUnique({
    where: { id },
    include: {
      detectedVideos: { orderBy: { views: "desc" }, take: 20 },
      creativeBriefs: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { generatedVideos: true } },
    },
  });

  if (!product || product.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Serialize BigInt fields
  const serialized = {
    ...product,
    totalViews: Number(product.totalViews),
    totalLikes: Number(product.totalLikes),
    totalShares: Number(product.totalShares),
    totalComments: Number(product.totalComments),
    detectedVideos: product.detectedVideos.map((v) => ({
      ...v,
      views: Number(v.views),
      likes: Number(v.likes),
      comments: Number(v.comments),
      shares: Number(v.shares),
    })),
  };

  return NextResponse.json(serialized);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const product = await prisma.ugcTrendingProduct.findUnique({ where: { id } });
  if (!product || product.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const updated = await prisma.ugcTrendingProduct.update({
    where: { id },
    data: {
      ...parsed.data,
      reviewedAt: new Date(),
    },
  });

  return NextResponse.json({
    ...updated,
    totalViews: Number(updated.totalViews),
    totalLikes: Number(updated.totalLikes),
    totalShares: Number(updated.totalShares),
    totalComments: Number(updated.totalComments),
  });
}
