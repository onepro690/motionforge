import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma, Prisma } from "@motion/database";
import { z } from "zod";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "20");
  const skip = (page - 1) * limit;

  // "APPROVED" inclui USED_FOR_GENERATION porque pra UI os dois são o mesmo
  // estado — o produto já passou pela aprovação e não deve voltar pra fila.
  const where: Prisma.UgcTrendingProductWhereInput = { userId };
  if (status === "APPROVED") {
    where.status = { in: ["APPROVED", "USED_FOR_GENERATION"] };
  } else if (status) {
    where.status = status as Prisma.UgcTrendingProductWhereInput["status"];
  }

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

// POST — criar produto manualmente com vídeo de referência
const createSchema = z.object({
  videoUrl: z.string().url(),
  productName: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Nome do produto e URL do vídeo são obrigatórios" }, { status: 400 });
  }

  const { videoUrl, productName } = parsed.data;

  // Extrai videoId e handle do URL do TikTok
  const videoIdMatch = videoUrl.match(/\/video\/(\d+)/);
  const videoId = videoIdMatch?.[1] ?? `manual-${Date.now()}`;
  const handleMatch = videoUrl.match(/@([^/]+)/);
  const creatorHandle = handleMatch?.[1] ?? null;

  // Verifica se o vídeo já existe
  const existingVideo = await prisma.ugcDetectedVideo.findUnique({ where: { videoId } });
  if (existingVideo) {
    return NextResponse.json({ error: "Este vídeo já está cadastrado em outro produto" }, { status: 409 });
  }

  // Cria produto + vídeo em uma transação
  const product = await prisma.ugcTrendingProduct.create({
    data: {
      userId,
      name: productName,
      status: "DETECTED",
      score: 50,
      detectedVideoCount: 1,
      creatorCount: 1,
      detectedVideos: {
        create: {
          userId,
          videoId,
          videoUrl,
          creatorHandle,
        },
      },
    },
    include: {
      _count: { select: { detectedVideos: true, generatedVideos: true } },
      detectedVideos: { take: 4, select: { thumbnailUrl: true, videoId: true, creatorHandle: true, views: true } },
    },
  });

  return NextResponse.json({
    ...product,
    totalViews: Number(product.totalViews),
    totalLikes: Number(product.totalLikes),
    totalShares: Number(product.totalShares),
    totalComments: Number(product.totalComments),
    detectedVideos: product.detectedVideos.map((v) => ({
      ...v,
      views: Number(v.views),
    })),
  });
}
