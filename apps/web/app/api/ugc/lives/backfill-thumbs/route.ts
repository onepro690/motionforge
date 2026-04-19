import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { fetchFullRoomInfo, fetchTikwmUserInfo } from "@/lib/ugc/live-scraper";

export const runtime = "nodejs";
export const maxDuration = 300;

// Backfill pra lives cujas imagens (thumbnail da live + avatar do host)
// expiraram do CDN do TikTok. Re-busca via webcast/room/info + tikwm user/info
// e rehospeda no Vercel Blob. Mirror do /api/ugc/backfill-thumbs dos produtos.

async function persistToBlob(
  key: string,
  sourceUrl: string,
): Promise<string | null> {
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
    const ext = contentType.includes("webp")
      ? "webp"
      : contentType.includes("png")
        ? "png"
        : "jpg";
    const blob = await put(`${key}.${ext}`, buffer, {
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

  const lives = await prisma.liveSession.findMany({
    where: { userId },
    select: {
      id: true,
      roomId: true,
      hostHandle: true,
      thumbnailUrl: true,
      hostAvatarUrl: true,
    },
  });

  let fixed = 0;
  let failed = 0;

  for (const live of lives) {
    let coverUrl: string | null = null;
    let avatarUrl: string | null = null;

    if (live.roomId) {
      const info = await fetchFullRoomInfo(live.roomId).catch(() => null);
      if (info?.coverUrl) coverUrl = info.coverUrl;
    }
    if (live.hostHandle) {
      const user = await fetchTikwmUserInfo(live.hostHandle).catch(() => null);
      if (user?.avatarUrl) avatarUrl = user.avatarUrl;
    }

    const updates: { thumbnailUrl?: string; hostAvatarUrl?: string } = {};

    if (coverUrl) {
      const blob = await persistToBlob(`live-thumb-${live.id}`, coverUrl);
      if (blob) updates.thumbnailUrl = blob;
    }
    if (avatarUrl) {
      const blob = await persistToBlob(`live-avatar-${live.id}`, avatarUrl);
      if (blob) updates.hostAvatarUrl = blob;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.liveSession.update({ where: { id: live.id }, data: updates });
      fixed++;
    } else {
      failed++;
    }
  }

  return NextResponse.json({ fixed, failed, total: lives.length });
}
