import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { scrapeLiveSessions, isLiveActive } from "@/lib/ugc/live-scraper";

export const maxDuration = 300;

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
  const apiKey = settings?.tiktokScraperApiKey ?? process.env.RAPIDAPI_KEY ?? undefined;

  const result = await scrapeLiveSessions([], apiKey);

  // Snapshot dos handles que já tínhamos antes desse scrape — pra contar
  // quantos creators genuinamente NOVOS entraram nessa rodada.
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

  for (const live of result.lives) {
    // Se havia placeholder manual (offline) pra esse handle, remove antes
    // de criar/atualizar a sessão real com roomId genuíno.
    const placeholderRoomId = `manual_${live.hostHandle}_${userId}`;
    if (live.roomId !== placeholderRoomId) {
      await prisma.liveSession.deleteMany({
        where: { userId, roomId: placeholderRoomId },
      });
    }

    const existing = await prisma.liveSession.findUnique({ where: { roomId: live.roomId } });

    const payload = {
      title: live.title,
      hostHandle: live.hostHandle,
      hostNickname: live.hostNickname,
      hostAvatarUrl: live.hostAvatarUrl,
      viewerCount: live.viewerCount,
      peakViewers: live.viewerCount,
      likeCount: live.likeCount,
      totalViewers: live.viewerCount,
      estimatedOrders: live.estimatedOrders,
      productCount: live.productCount,
      products: live.products as object[],
      isLive: live.isLive,
      startedAt: live.startedAt ? new Date(live.startedAt) : null,
      hlsUrl: live.hlsUrl ?? null,
      flvUrl: live.flvUrl ?? null,
      liveUrl: live.liveUrl,
      thumbnailUrl: live.thumbnailUrl,
      salesScore: live.salesScore,
      scrapedAt: new Date(),
    };

    if (existing) {
      await prisma.liveSession.update({
        where: { id: existing.id },
        data: {
          ...payload,
          peakViewers: Math.max(existing.peakViewers, live.viewerCount),
          // Preserva HLS só se nova for válida (URLs expiram)
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
  }

  // Verifica EXPLICITAMENTE todas as lives ativas do user via webcast/room/info
  // (endpoint autoritativo, não é WAF-bloqueado). Se status != 2, marca ended.
  // Pula as que já foram confirmadas pelo scrape atual.
  const freshRoomIds = new Set(result.lives.map((l) => l.roomId));
  const currentLive = await prisma.liveSession.findMany({
    where: { userId, isLive: true, roomId: { notIn: [...freshRoomIds] } },
    select: { id: true, roomId: true },
  });
  const endedIds: string[] = [];
  await Promise.all(
    currentLive.map(async (s) => {
      const active = await isLiveActive(s.roomId).catch(() => false);
      if (!active) endedIds.push(s.id);
    }),
  );
  if (endedIds.length > 0) {
    await prisma.liveSession.updateMany({
      where: { id: { in: endedIds } },
      data: { isLive: false, endedAt: new Date() },
    });
  }

  const liveNow = result.lives.filter((l) => l.isLive).length;

  return NextResponse.json({
    success: true,
    total: result.lives.length,
    liveNow,
    newSessions: newCount,
    newCreators: newHandles.size,
    updatedSessions: updatedCount,
    usedMock: result.debug?.usedMock ?? false,
    hasApiKey: !!apiKey,
    source: result.debug?.usedMock ? "mock" : "tikwm",
    debug: result.debug,
  });
}
