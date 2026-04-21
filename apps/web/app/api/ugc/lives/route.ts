import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma, Prisma } from "@motion/database";
import { fetchFullRoomInfo, checkLiveStatusViaWebcast } from "@/lib/ugc/live-scraper";

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

  // Refresh ao vivo: dois modos de verificação em paralelo.
  //
  // A) Sessions isLive=true: fetchFullRoomInfo(roomId) — barato, confirma
  //    se o mesmo room ainda está ao ar e atualiza viewer/like.
  //
  // B) Sessions encerradas < 48h: checkLiveStatusViaWebcast(handle) —
  //    detecta o creator voltando ao ar MESMO se com roomId diferente
  //    (live reiniciada conta como novo room). Sem isso, o card fica
  //    preso em "Encerrada" até o próximo scrape global.
  //
  // Pula roomIds placeholder (`inferred_`, `manual_`) — fetchFullRoomInfo
  // neles falha. Pra esses, confiamos no scrape pra criar session real.
  const RELIVE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
  const nowMs = Date.now();

  const liveRoomIdTargets = sessionsRaw.filter(
    (s) =>
      s.isLive === true &&
      typeof s.roomId === "string" &&
      s.roomId &&
      /^\d{15,}$/.test(s.roomId as string),
  );

  const endedHandlesSeen = new Set<string>();
  const endedHandleTargets = sessionsRaw.filter((s) => {
    if (s.isLive === true) return false;
    const handle = s.hostHandle as string | undefined;
    if (!handle) return false;
    if (endedHandlesSeen.has(handle)) return false;
    const ts = (s.endedAt ?? s.scrapedAt) as Date | string | null;
    if (!ts) return false;
    const ageMs = nowMs - new Date(ts as string).getTime();
    if (ageMs < 0 || ageMs > RELIVE_WINDOW_MS) return false;
    endedHandlesSeen.add(handle);
    return true;
  });

  const CONCURRENCY = 10;
  const refreshed = new Map<
    string,
    { viewerCount: number; likeCount: number; isLive: boolean; newRoomId?: string }
  >();

  // A) Re-verifica live atuais por roomId
  for (let i = 0; i < liveRoomIdTargets.length; i += CONCURRENCY) {
    const batch = liveRoomIdTargets.slice(i, i + CONCURRENCY);
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
              ...(!stillLive ? { endedAt: new Date() } : {}),
            },
          });
        } catch {
          /* ignore */
        }
      }),
    );
  }

  // B) Detecta relive em sessões encerradas via handle
  for (let i = 0; i < endedHandleTargets.length; i += CONCURRENCY) {
    const batch = endedHandleTargets.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (s) => {
        const handle = s.hostHandle as string;
        const oldRoomId = s.roomId as string;
        const check = await checkLiveStatusViaWebcast(handle).catch(() => ({ isLive: false }) as const);
        if (!check.isLive || !("roomId" in check) || !check.roomId) return;
        const info = await fetchFullRoomInfo(check.roomId);
        if (!info || info.status !== 2) return;
        const viewerCount = info.userCount ?? check.userCount ?? 0;
        const likeCount = info.likeCount ?? check.enterCount ?? 0;
        refreshed.set(oldRoomId, {
          viewerCount,
          likeCount,
          isLive: true,
          newRoomId: check.roomId,
        });
        try {
          if (check.roomId === oldRoomId) {
            // Mesmo roomId: só reativa
            await prisma.liveSession.update({
              where: { roomId: oldRoomId },
              data: {
                isLive: true,
                endedAt: null,
                viewerCount,
                likeCount,
                hlsUrl: info.hlsUrl ?? undefined,
                flvUrl: info.flvUrl ?? undefined,
                title: info.title ?? (s.title as string) ?? "",
                scrapedAt: new Date(),
              },
            });
          } else {
            // Novo roomId: tenta migrar o card existente pro novo room.
            // Se o novo roomId já existe em outra session (scrape criou),
            // só reativa a que tiver o novo roomId.
            const existingNew = await prisma.liveSession.findUnique({
              where: { roomId: check.roomId },
            });
            if (existingNew) {
              await prisma.liveSession.update({
                where: { roomId: check.roomId },
                data: {
                  isLive: true,
                  endedAt: null,
                  viewerCount,
                  likeCount,
                  hlsUrl: info.hlsUrl ?? undefined,
                  flvUrl: info.flvUrl ?? undefined,
                  title: info.title ?? existingNew.title,
                  scrapedAt: new Date(),
                },
              });
            } else {
              await prisma.liveSession.update({
                where: { roomId: oldRoomId },
                data: {
                  roomId: check.roomId,
                  isLive: true,
                  endedAt: null,
                  viewerCount,
                  likeCount,
                  hlsUrl: info.hlsUrl ?? undefined,
                  flvUrl: info.flvUrl ?? undefined,
                  title: info.title ?? (s.title as string) ?? "",
                  startedAt: info.startedAt ? new Date(info.startedAt) : new Date(),
                  scrapedAt: new Date(),
                },
              });
            }
          }
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
            ...(fresh.newRoomId ? { roomId: fresh.newRoomId, endedAt: null } : {}),
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
