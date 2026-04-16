import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";
import { fetchTikwmDetail } from "@/lib/ugc/reference-video";

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

// POST — adicionar vídeo manual ao produto
const addVideoSchema = z.object({
  videoUrl: z.string().url(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const userId = session.user.id;

  const product = await prisma.ugcTrendingProduct.findUnique({ where: { id } });
  if (!product || product.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = addVideoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "URL inválida" }, { status: 400 });
  }

  const { videoUrl } = parsed.data;

  // Extrai videoId do URL do TikTok
  const videoIdMatch = videoUrl.match(/\/video\/(\d+)/);
  const videoId = videoIdMatch?.[1] ?? `manual-${Date.now()}`;

  // Verifica se já existe
  const existing = await prisma.ugcDetectedVideo.findUnique({ where: { videoId } });
  if (existing) {
    return NextResponse.json({ error: "Este vídeo já está cadastrado" }, { status: 409 });
  }

  // Busca metadados via tikwm
  let thumbnailUrl: string | null = null;
  let description: string | null = null;
  let creatorHandle: string | null = null;
  try {
    const detail = await fetchTikwmDetail(videoUrl);
    if (detail) {
      description = detail.title || null;
    }
    // Extrai handle do URL
    const handleMatch = videoUrl.match(/@([^/]+)/);
    creatorHandle = handleMatch?.[1] ?? null;
  } catch { /* ok */ }

  const video = await prisma.ugcDetectedVideo.create({
    data: {
      userId,
      productId: id,
      videoId,
      videoUrl,
      thumbnailUrl,
      description,
      creatorHandle,
    },
  });

  // Atualiza contadores do produto
  await prisma.ugcTrendingProduct.update({
    where: { id },
    data: {
      detectedVideoCount: { increment: 1 },
    },
  });

  return NextResponse.json({
    ...video,
    views: Number(video.views),
    likes: Number(video.likes),
    comments: Number(video.comments),
    shares: Number(video.shares),
  });
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
