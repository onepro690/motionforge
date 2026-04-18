import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { scrapeTrendingProducts } from "@/lib/ugc/scraper";
import { scoreProduct } from "@/lib/ugc/scorer";
import { DEFAULT_SCORING_WEIGHTS, TIKTOK_SEARCH_KEYWORDS } from "@/lib/ugc/defaults";

export const maxDuration = 120;

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
  const apiKey = settings?.tiktokScraperApiKey ?? process.env.RAPIDAPI_KEY;
  const weights = (settings?.scoringWeights as typeof DEFAULT_SCORING_WEIGHTS) ?? DEFAULT_SCORING_WEIGHTS;
  const keywords = settings?.searchKeywords
    ? settings.searchKeywords.split(",").map((k) => k.trim()).filter(Boolean)
    : TIKTOK_SEARCH_KEYWORDS;

  // Dedup existente: agrupa produtos pelo nome normalizado e mantém o
  // canônico (o que tem mais vídeos gerados, desempata pelo maior score).
  // Os duplicados têm seus detectedVideos/generatedVideos re-apontados pro
  // canônico antes de serem apagados. Roda sempre — é barato e garante que
  // a lista nunca mostra o mesmo produto duas vezes.
  const allProducts = await prisma.ugcTrendingProduct.findMany({
    where: { userId },
    include: { _count: { select: { generatedVideos: true } } },
  });
  const byKey = new Map<string, typeof allProducts>();
  for (const p of allProducts) {
    const key = p.name.trim().toLowerCase();
    const arr = byKey.get(key) ?? [];
    arr.push(p);
    byKey.set(key, arr);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      if (b._count.generatedVideos !== a._count.generatedVideos) {
        return b._count.generatedVideos - a._count.generatedVideos;
      }
      return b.score - a.score;
    });
    const [canonical, ...dups] = group;
    for (const dup of dups) {
      await prisma.ugcDetectedVideo.updateMany({
        where: { productId: dup.id },
        data: { productId: canonical.id },
      }).catch(() => {});
      await prisma.ugcGeneratedVideo.updateMany({
        where: { productId: dup.id },
        data: { productId: canonical.id },
      }).catch(() => {});
      await prisma.ugcTrendingProduct.delete({ where: { id: dup.id } }).catch(() => {});
    }
  }

  const result = await scrapeTrendingProducts(keywords, apiKey ?? undefined);

  let newCount = 0;
  let updatedCount = 0;

  for (const scrapedProduct of result.products) {
    const score = scoreProduct(scrapedProduct, weights);
    if (score.score < 5) continue;

    // Dedup por nome case-insensitive — evita criar dois cards pro mesmo
    // produto quando o scraper retorna variações de capitalização/espaço.
    // Inclui REJECTED: se o user já rejeitou, a gente só atualiza métricas,
    // nunca ressuscita o card.
    const existing = await prisma.ugcTrendingProduct.findFirst({
      where: {
        userId,
        name: { equals: scrapedProduct.name.trim(), mode: "insensitive" },
      },
    });

    const totalViews = scrapedProduct.videos.reduce((s, v) => s + v.views, 0);
    const totalLikes = scrapedProduct.videos.reduce((s, v) => s + v.likes, 0);
    const totalShares = scrapedProduct.videos.reduce((s, v) => s + v.shares, 0);
    const totalComments = scrapedProduct.videos.reduce((s, v) => s + v.comments, 0);

    if (existing) {
      await prisma.ugcTrendingProduct.update({
        where: { id: existing.id },
        data: {
          score: score.score,
          detectedVideoCount: scrapedProduct.videos.length,
          totalViews,
          totalLikes,
          totalShares,
          totalComments,
          viewGrowthRate: score.viewGrowthRate,
          engagementRate: score.engagementRate,
          creatorCount: score.creatorCount,
          accelerationScore: score.accelerationScore,
          lastDetectedAt: new Date(),
          thumbnailUrl: scrapedProduct.thumbnailUrl ?? existing.thumbnailUrl,
          productUrl: scrapedProduct.productUrl ?? existing.productUrl,
        },
      });

      // Upsert videos for existing product
      for (const video of scrapedProduct.videos.slice(0, 20)) {
        await prisma.ugcDetectedVideo.upsert({
          where: { videoId: video.videoId },
          update: {
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
            collectedAt: new Date(),
          },
          create: {
            userId,
            productId: existing.id,
            videoId: video.videoId,
            creatorHandle: video.creatorHandle,
            videoUrl: video.videoUrl,      // real tiktok.com/@handle/video/id URL
            thumbnailUrl: video.thumbnailUrl,
            description: video.description,
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
          },
        }).catch(() => {});
      }

      updatedCount++;
    } else {
      const created = await prisma.ugcTrendingProduct.create({
        data: {
          userId,
          name: scrapedProduct.name,
          category: scrapedProduct.category ?? null,
          thumbnailUrl: scrapedProduct.thumbnailUrl ?? null,
          productUrl: scrapedProduct.productUrl ?? null,
          score: score.score,
          status: "DETECTED",
          detectedVideoCount: scrapedProduct.videos.length,
          totalViews,
          totalLikes,
          totalShares,
          totalComments,
          viewGrowthRate: score.viewGrowthRate,
          engagementRate: score.engagementRate,
          creatorCount: score.creatorCount,
          accelerationScore: score.accelerationScore,
        },
      });

      // Save top videos with real TikTok URLs
      for (const video of scrapedProduct.videos.slice(0, 20)) {
        await prisma.ugcDetectedVideo.upsert({
          where: { videoId: video.videoId },
          update: {
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
            collectedAt: new Date(),
          },
          create: {
            userId,
            productId: created.id,
            videoId: video.videoId,
            creatorHandle: video.creatorHandle,
            videoUrl: video.videoUrl,      // real tiktok.com/@handle/video/id URL
            thumbnailUrl: video.thumbnailUrl,
            description: video.description,
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
          },
        }).catch(() => {});
      }

      newCount++;
    }
  }

  return NextResponse.json({
    success: true,
    rawVideoCount: result.rawVideoCount,
    productsFound: result.products.length,
    newProducts: newCount,
    updatedProducts: updatedCount,
    scrapedAt: result.scrapedAt,
  });
}
