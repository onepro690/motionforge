import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma, Prisma } from "@motion/database";
import { fetchFullRoomInfo } from "@/lib/ugc/live-scraper";

export const maxDuration = 60;

// Dedup por hostHandle: cada creator aparece uma vez, na sua "melhor" sessão
// (ao vivo > viewerCount > scrapedAt mais recente). Usa DISTINCT ON do PG.
//
// Refresh ao vivo: a cada GET, dispara fetchFullRoomInfo em paralelo nas
// sessions live da página atual e atualiza viewerCount/likeCount na hora.

export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get("filter") ?? "all";
  const page   = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit  = 40;
  const offset = (page - 1) * limit;

  const filterCond =
    filter === "live"
      ? Prisma.sql`AND "isLive" = true`
      : filter === "recorded"
        ? Prisma.sql`AND "recordingStatus" = 'DONE'`
        : Prisma.sql``;

  // 1) Página: DISTINCT ON (hostHandle) escolhe a "melhor" linha por creator,
  //    depois reordena pelo critério de exibição e aplica paginação.
  const sessionsRaw = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM (
      SELECT DISTINCT ON ("hostHandle") *
      FROM live_sessions
      WHERE "userId" = ${userId} ${filterCond}
      ORDER BY "hostHandle", "isLive" DESC, "viewerCount" DESC, "scrapedAt" DESC
    ) AS deduped
    ORDER BY "isLive" DESC, "viewerCount" DESC, "scrapedAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  // 2) Total de creators únicos (não de linhas)
  const totalRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT "hostHandle") AS count
    FROM live_sessions
    WHERE "userId" = ${userId} ${filterCond}
  `;
  const total = Number(totalRows[0]?.count ?? 0);

  // 3) Live count (creators únicos ao vivo)
  const liveRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT "hostHandle") AS count
    FROM live_sessions
    WHERE "userId" = ${userId} AND "isLive" = true
  `;
  const liveCount = Number(liveRows[0]?.count ?? 0);

  // 4) Replay count
  const replayRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT "hostHandle") AS count
    FROM live_sessions
    WHERE "userId" = ${userId} AND "isLive" = false
  `;
  const replayCount = Number(replayRows[0]?.count ?? 0);

  // Refresh ao vivo: dispara fetchFullRoomInfo em paralelo nas sessions live
  // da página atual e atualiza viewerCount/likeCount na hora.
  const liveTargets = sessionsRaw.filter(
    (s) => s.isLive === true && typeof s.roomId === "string" && s.roomId,
  );

  const CONCURRENCY = 10;
  const refreshed = new Map<string, { viewerCount: number; likeCount: number; isLive: boolean }>();

  for (let i = 0; i < liveTargets.length; i += CONCURRENCY) {
    const batch = liveTargets.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (s) => {
        const roomId = s.roomId as string;
        const info = await fetchFullRoomInfo(roomId);
        if (!info) return;
        const stillLive = info.status === 2;
        const viewerCount = info.userCount ?? Number(s.viewerCount ?? 0);
        const likeCount = info.likeCount ?? Number(s.likeCount ?? 0);
        refreshed.set(roomId, { viewerCount, likeCount, isLive: stillLive });
        const prevPeak = Number(s.peakViewers ?? 0);
        try {
          await prisma.liveSession.update({
            where: { roomId },
            data: {
              viewerCount,
              likeCount,
              isLive: stillLive,
              peakViewers: viewerCount > prevPeak ? viewerCount : prevPeak,
              scrapedAt: new Date(),
            },
          });
        } catch {
          /* ignore */
        }
      }),
    );
  }

  const serialized = sessionsRaw.map((s) => {
    const roomId = typeof s.roomId === "string" ? s.roomId : "";
    const fresh = roomId ? refreshed.get(roomId) : undefined;
    return {
      ...s,
      ...(fresh
        ? {
            viewerCount: fresh.viewerCount,
            likeCount: fresh.likeCount,
            isLive: fresh.isLive,
            peakViewers: Math.max(Number(s.peakViewers ?? 0), fresh.viewerCount),
          }
        : {}),
      likeCount:    Number((fresh?.likeCount ?? s.likeCount) ?? 0),
      totalViewers: Number(s.totalViewers ?? 0),
    };
  });

  return NextResponse.json({
    sessions: serialized,
    total,
    liveCount,
    replayCount,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
}
