import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

// Backfill pra produtos existentes que ficaram com thumbnailUrl do TikTok CDN
// já expirada (x-expires no passado → 403). Re-busca via tikwm e persiste no Blob.

const TIKWM_API = "https://www.tikwm.com/api/";

async function fetchFreshCover(tiktokUrl: string): Promise<string | null> {
  try {
    const res = await fetch(TIKWM_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: tiktokUrl, hd: "1" }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: number;
      data?: { cover?: string; origin_cover?: string; ai_dynamic_cover?: string };
    };
    if (data.code !== 0) return null;
    return data.data?.cover ?? data.data?.origin_cover ?? null;
  } catch {
    return null;
  }
}

async function persistToBlob(videoId: string, sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.tiktok.com/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = contentType.includes("webp") ? "webp" : contentType.includes("png") ? "png" : "jpg";
    const blob = await put(`ugc-thumb-${videoId}.${ext}`, buffer, {
      access: "public",
      contentType,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return blob.url;
  } catch {
    return null;
  }
}

export async function POST(_req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const products = await prisma.ugcTrendingProduct.findMany({
    where: { userId },
    include: {
      detectedVideos: {
        orderBy: { views: "desc" },
        take: 3,
        select: { id: true, videoId: true, videoUrl: true, thumbnailUrl: true },
      },
    },
  });

  let fixed = 0;
  let failed = 0;
  const results: Array<{ name: string; status: string; url?: string }> = [];

  for (const product of products) {
    let success = false;
    for (const video of product.detectedVideos) {
      if (!video.videoUrl) continue;
      const freshCover = await fetchFreshCover(video.videoUrl);
      if (!freshCover) continue;
      const blobUrl = await persistToBlob(video.videoId, freshCover);
      if (!blobUrl) continue;

      await prisma.ugcTrendingProduct.update({
        where: { id: product.id },
        data: { thumbnailUrl: blobUrl },
      });
      await prisma.ugcDetectedVideo.update({
        where: { id: video.id },
        data: { thumbnailUrl: blobUrl },
      });

      fixed++;
      success = true;
      results.push({ name: product.name, status: "ok", url: blobUrl });
      break;
    }
    if (!success) {
      failed++;
      results.push({ name: product.name, status: "failed" });
    }
  }

  return NextResponse.json({ fixed, failed, total: products.length, results });
}
