// Cron de descoberta contínua de lives TikTok Shop.
//
// Objetivo: crescer o pool (UgcKnownCreator) e detectar quem inicia
// live mesmo sem o usuário clicar em "Buscar". Cada execução:
//  1. Roda o scraper (feed search + fallback api-live) que já popula
//     UgcKnownCreator e retorna lives ativas.
//  2. Para cada live detectada: faz upsert de LiveSession para TODOS os
//     usuários cadastrados, garantindo que aparece na UI deles.
//
// Schedule: a cada 15min. Concorrente com cron de gravação (sem contenção).

import { NextResponse } from "next/server";
import { prisma } from "@motion/database";
import { scrapeLiveSessions, isLiveActive } from "@/lib/ugc/live-scraper";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const result = await scrapeLiveSessions([], undefined);

  const users = await prisma.user.findMany({ select: { id: true } });
  let upserts = 0;

  for (const live of result.lives) {
    for (const u of users) {
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

      // Remove placeholder manual se existir p/ esse handle
      const placeholderRoomId = `manual_${live.hostHandle}_${u.id}`;
      if (live.roomId !== placeholderRoomId) {
        await prisma.liveSession
          .deleteMany({ where: { userId: u.id, roomId: placeholderRoomId } })
          .catch(() => null);
      }

      await prisma.liveSession
        .upsert({
          where: { roomId: live.roomId },
          create: { userId: u.id, roomId: live.roomId, ...payload },
          update: {
            ...payload,
            hlsUrl: live.hlsUrl || undefined,
            flvUrl: live.flvUrl || undefined,
          },
        })
        .catch(() => null);
      upserts++;
    }
  }

  // Marca offline quem sumiu (checa via webcast/room/info)
  const freshRoomIds = new Set(result.lives.map((l) => l.roomId));
  const stillLive = await prisma.liveSession.findMany({
    where: { isLive: true, roomId: { notIn: [...freshRoomIds] } },
    select: { id: true, roomId: true },
    take: 200,
  });
  const endedIds: string[] = [];
  await Promise.all(
    stillLive.map(async (s) => {
      if (!s.roomId.startsWith("manual_")) {
        const active = await isLiveActive(s.roomId).catch(() => false);
        if (!active) endedIds.push(s.id);
      }
    }),
  );
  if (endedIds.length > 0) {
    await prisma.liveSession.updateMany({
      where: { id: { in: endedIds } },
      data: { isLive: false, endedAt: new Date() },
    });
  }

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    livesFound: result.lives.length,
    users: users.length,
    upserts,
    ended: endedIds.length,
    debug: result.debug,
  });
}
