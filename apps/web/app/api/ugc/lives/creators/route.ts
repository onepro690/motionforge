import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { fetchTikwmUserInfo, checkCreatorLiveNow } from "@/lib/ugc/live-scraper";

// Aceita qualquer forma: @handle, handle, URL de live, URL de perfil
function extractHandle(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/);
  if (m) return m[1];
  if (s.startsWith("@")) return s.slice(1);
  if (/^[a-zA-Z0-9._]+$/.test(s)) return s;
  return null;
}

function calcSalesScore(v: { viewerCount: number; likeCount: number }): number {
  return Math.round(
    Math.min(v.viewerCount / 500_000, 1) * 50 +
    Math.min(v.likeCount / 100_000, 1) * 30 +
    20,
  );
}

// POST /api/ugc/lives/creators — adiciona creator manualmente.
// Busca metadata (nickname + avatar) via tikwm e checa se já está live AGORA.
// Se estiver live com commerce → cria LiveSession imediatamente (card aparece).
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { input?: string };
  const handle = body.input ? extractHandle(body.input) : null;
  if (!handle) {
    return NextResponse.json(
      { error: "invalid_input", message: "Formato inválido. Use @handle ou URL da live/perfil." },
      { status: 400 },
    );
  }

  // 1. Tikwm user info — nickname + avatar (sem precisar de WAF TikTok)
  const info = await fetchTikwmUserInfo(handle);
  const nickname = info?.nickname ?? handle;
  const avatarUrl = info?.avatarUrl ?? "";

  // 2. Upsert creator com metadata
  const creator = await prisma.ugcKnownCreator.upsert({
    where: { handle },
    create: { handle, nickname, avatarUrl, region: "BR", source: "manual" },
    update: { nickname, avatarUrl, source: "manual" },
  });

  // 3. Checa live AGORA (api-live + webcast/room/info)
  let liveSessionId: string | null = null;
  let isCurrentlyLive = false;
  try {
    const live = await checkCreatorLiveNow(handle);
    if (live && live.hasCommerce) {
      isCurrentlyLive = true;
      const viewerCount = live.userCount ?? 0;
      const likeCount = live.likeCount ?? 0;
      const saved = await prisma.liveSession.upsert({
        where: { roomId: live.roomId },
        create: {
          userId: session.user.id,
          roomId: live.roomId,
          title: live.title ?? "",
          hostHandle: handle,
          hostNickname: nickname,
          hostAvatarUrl: avatarUrl,
          viewerCount,
          peakViewers: viewerCount,
          likeCount: BigInt(likeCount),
          totalViewers: BigInt(viewerCount),
          estimatedOrders: 0,
          productCount: 1,
          products: [],
          isLive: true,
          startedAt: live.startedAt ? new Date(live.startedAt) : new Date(),
          hlsUrl: live.hlsUrl,
          flvUrl: live.flvUrl,
          liveUrl: `https://www.tiktok.com/@${handle}/live`,
          thumbnailUrl: live.coverUrl ?? avatarUrl,
          salesScore: calcSalesScore({ viewerCount, likeCount }),
          scrapedAt: new Date(),
        },
        update: {
          title: live.title ?? "",
          hostNickname: nickname,
          hostAvatarUrl: avatarUrl,
          viewerCount,
          peakViewers: Math.max(viewerCount, 0),
          likeCount: BigInt(likeCount),
          totalViewers: BigInt(viewerCount),
          isLive: true,
          hlsUrl: live.hlsUrl,
          flvUrl: live.flvUrl,
          thumbnailUrl: live.coverUrl ?? avatarUrl,
          scrapedAt: new Date(),
        },
      });
      liveSessionId = saved.id;

      await prisma.ugcKnownCreator
        .update({
          where: { handle },
          data: { lastSeenLive: new Date(), liveCount: { increment: 1 } },
        })
        .catch(() => null);
    }
  } catch {
    // Não bloqueia o add se checagem falhar
  }

  // 4. Se não está live, cria placeholder "Encerrada" pra aparecer na lista.
  //    Usa roomId sintético estável. Quando futuro scrape achar o creator live,
  //    o placeholder é removido automaticamente (ver scrape/route.ts).
  if (!isCurrentlyLive) {
    const placeholderRoomId = `manual_${handle}_${session.user.id}`;
    const placeholder = await prisma.liveSession.upsert({
      where: { roomId: placeholderRoomId },
      create: {
        userId: session.user.id,
        roomId: placeholderRoomId,
        title: "",
        hostHandle: handle,
        hostNickname: nickname,
        hostAvatarUrl: avatarUrl,
        viewerCount: 0,
        peakViewers: 0,
        likeCount: BigInt(0),
        totalViewers: BigInt(0),
        estimatedOrders: 0,
        productCount: 0,
        products: [],
        isLive: false,
        liveUrl: `https://www.tiktok.com/@${handle}/live`,
        thumbnailUrl: avatarUrl,
        salesScore: 0,
        scrapedAt: new Date(),
      },
      update: {
        hostNickname: nickname,
        hostAvatarUrl: avatarUrl,
        thumbnailUrl: avatarUrl,
        scrapedAt: new Date(),
      },
    });
    liveSessionId = placeholder.id;
  }

  return NextResponse.json({
    success: true,
    creator,
    liveNow: isCurrentlyLive,
    liveSessionId,
  });
}

// DELETE /api/ugc/lives/creators?handle=X — remove creator do pool
export async function DELETE(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const handle = searchParams.get("handle");
  if (!handle) return NextResponse.json({ error: "missing_handle" }, { status: 400 });

  await prisma.ugcKnownCreator.delete({ where: { handle } }).catch(() => null);
  await prisma.liveSession.deleteMany({
    where: { userId: session.user.id, hostHandle: handle },
  });
  return NextResponse.json({ success: true });
}
