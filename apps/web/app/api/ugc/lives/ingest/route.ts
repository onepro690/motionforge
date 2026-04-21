import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export const maxDuration = 60;

// Recebe lives já verificadas pelo worker local (IP residencial bypassa
// WAF). Upserta no DB com a mesma forma que /scrape faz, e marca como
// "ended" qualquer live que estava isLive=true mas não veio no batch.

interface VerifiedLive {
  roomId: string;
  hostHandle: string;
  hostNickname?: string;
  hostAvatarUrl?: string;
  title?: string;
  viewerCount?: number;
  likeCount?: number;
  hlsUrl?: string;
  flvUrl?: string;
  thumbnailUrl?: string;
  startedAt?: string | null;
  hasCommerce?: boolean;
}

function calcSalesScore(v: { viewerCount: number; likeCount: number; isLive: boolean }): number {
  return Math.round(
    Math.min(v.viewerCount / 500_000, 1) * 50 +
      Math.min(v.likeCount / 100_000, 1) * 30 +
      (v.isLive ? 20 : 0),
  );
}

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  let body: { lives?: VerifiedLive[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rawLives = Array.isArray(body.lives) ? body.lives : [];
  // Filtro duro: só entra no DB quem está confirmadamente com commerce e
  // roomId numérico real (worker pode devolver outras shapes, paranoia).
  const lives = rawLives.filter(
    (l) =>
      l &&
      typeof l.roomId === "string" &&
      /^\d{15,}$/.test(l.roomId) &&
      typeof l.hostHandle === "string" &&
      l.hostHandle.length > 0 &&
      l.hasCommerce === true,
  );

  const preExistingHandles = new Set(
    (
      await prisma.liveSession.findMany({
        where: { userId },
        select: { hostHandle: true },
        distinct: ["hostHandle"],
      })
    ).map((r) => r.hostHandle),
  );

  let newCount = 0;
  let updatedCount = 0;
  const newHandles = new Set<string>();
  const now = new Date();

  for (const live of lives) {
    const viewerCount = Number(live.viewerCount ?? 0);
    const likeCount = Number(live.likeCount ?? 0);

    // Remove qualquer placeholder manual desse handle antes de criar a real.
    const placeholderRoomId = `manual_${live.hostHandle}_${userId}`;
    if (live.roomId !== placeholderRoomId) {
      await prisma.liveSession.deleteMany({
        where: { userId, roomId: placeholderRoomId },
      });
    }

    const existing = await prisma.liveSession.findUnique({ where: { roomId: live.roomId } });

    const payload = {
      title: live.title ?? "",
      hostHandle: live.hostHandle,
      hostNickname: live.hostNickname ?? live.hostHandle,
      hostAvatarUrl: live.hostAvatarUrl ?? "",
      viewerCount,
      peakViewers: viewerCount,
      likeCount,
      totalViewers: viewerCount,
      estimatedOrders: 0,
      productCount: 1,
      products: [] as object[],
      isLive: true,
      startedAt: live.startedAt ? new Date(live.startedAt) : null,
      hlsUrl: live.hlsUrl ?? null,
      flvUrl: live.flvUrl ?? null,
      liveUrl: `https://www.tiktok.com/@${live.hostHandle}/live`,
      thumbnailUrl: live.thumbnailUrl ?? live.hostAvatarUrl ?? "",
      salesScore: calcSalesScore({ viewerCount, likeCount, isLive: true }),
      scrapedAt: now,
    };

    if (existing) {
      await prisma.liveSession.update({
        where: { id: existing.id },
        data: {
          ...payload,
          peakViewers: Math.max(existing.peakViewers, viewerCount),
          hlsUrl: live.hlsUrl || existing.hlsUrl,
          flvUrl: live.flvUrl || existing.flvUrl,
        },
      });
      updatedCount++;
    } else {
      await prisma.liveSession.create({ data: { userId, roomId: live.roomId, ...payload } });
      newCount++;
    }

    if (!preExistingHandles.has(live.hostHandle)) {
      newHandles.add(live.hostHandle);
    }

    // Atualiza histórico do creator (peak, last seen, title)
    await prisma.ugcKnownCreator
      .update({
        where: { handle: live.hostHandle },
        data: {
          lastSeenLive: now,
          liveCount: { increment: 1 },
          lastLiveStartedAt: live.startedAt ? new Date(live.startedAt) : now,
          lastLiveTitle: live.title?.slice(0, 200) ?? null,
          hasCommerce: true,
        },
      })
      .catch(() => null);
    await prisma.$executeRaw`
      UPDATE ugc_known_creators
      SET "peakViewers" = GREATEST("peakViewers", ${viewerCount})
      WHERE handle = ${live.hostHandle}
    `.catch(() => null);
  }

  // Cleanup: sessões previamente live que não vieram nesse batch verificado.
  // Só mexe em roomIds numéricos reais (placeholders `inferred_`/`manual_`
  // não deveriam existir com isLive=true depois do ingest, mas por via das
  // dúvidas, marca-ended também).
  const freshRoomIds = new Set(lives.map((l) => l.roomId));
  if (freshRoomIds.size > 0) {
    const stale = await prisma.liveSession.findMany({
      where: { userId, isLive: true, roomId: { notIn: [...freshRoomIds] } },
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.liveSession.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { isLive: false, endedAt: now },
      });
    }
  }

  return NextResponse.json({
    success: true,
    total: lives.length,
    newSessions: newCount,
    newCreators: newHandles.size,
    updatedSessions: updatedCount,
    source: "worker",
  });
}
