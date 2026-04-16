// Debug endpoint: roda o pipeline passo a passo e retorna diagnóstico completo
import { NextResponse } from "next/server";
import { scrapeLiveSessions } from "@/lib/ugc/live-scraper";
import { prisma } from "@motion/database";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export const maxDuration = 300;
export const runtime = "nodejs";

interface StepTrace { step: string; ok: boolean; data?: unknown; error?: string }

export async function GET() {
  const trace: StepTrace[] = [];

  // 1. Testa tikwm fetch
  try {
    const url = `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent("ao vivo tiktok shop brasil")}&count=30&cursor=0&region=br&publish_time=1&sort_type=1`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    const status = r.status;
    const body = await r.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const vidCount = (parsed as { data?: { videos?: unknown[] } } | null)?.data?.videos?.length ?? 0;
    trace.push({ step: "tikwm fetch", ok: r.ok, data: { status, vidCount, bodySnippet: body.slice(0, 300) } });
  } catch (e) {
    trace.push({ step: "tikwm fetch", ok: false, error: (e as Error).message });
    return NextResponse.json({ trace });
  }

  // 2. Testa import do tiktok-live-connector
  let TikTokWebClient: unknown;
  try {
    const mod = await import("tiktok-live-connector");
    TikTokWebClient = (mod as { TikTokWebClient: unknown }).TikTokWebClient;
    trace.push({ step: "import tiktok-live-connector", ok: !!TikTokWebClient, data: { hasClass: !!TikTokWebClient, moduleKeys: Object.keys(mod).slice(0, 20) } });
  } catch (e) {
    trace.push({ step: "import tiktok-live-connector", ok: false, error: (e as Error).message });
    return NextResponse.json({ trace });
  }

  // 3. Testa criar client e chamar fetchRoomInfoFromApiLive
  try {
    const Cls = TikTokWebClient as new () => {
      fetchRoomInfoFromApiLive: { call: (p: { uniqueId: string }) => Promise<unknown> };
    };
    const client = new Cls();
    const r = await client.fetchRoomInfoFromApiLive.call({ uniqueId: "liseleooliveira" });
    const rr = r as { data?: { liveRoom?: { status?: number; title?: string } } };
    trace.push({
      step: "fetchRoomInfoFromApiLive",
      ok: true,
      data: {
        status: rr.data?.liveRoom?.status,
        title: rr.data?.liveRoom?.title,
      },
    });
  } catch (e) {
    trace.push({ step: "fetchRoomInfoFromApiLive", ok: false, error: (e as Error).message, data: { stack: (e as Error).stack?.slice(0, 800) } });
  }

  // 4. Auth check
  let userId: string | null = null;
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    userId = session?.user.id ?? null;
    trace.push({ step: "auth", ok: !!userId, data: { hasSession: !!session, userId: userId?.slice(0, 8) } });
  } catch (e) {
    trace.push({ step: "auth", ok: false, error: (e as Error).message });
  }

  // 5. Roda o scraper completo + tenta salvar no DB
  try {
    const t0 = Date.now();
    const result = await scrapeLiveSessions([]);
    trace.push({
      step: "scrapeLiveSessions full",
      ok: true,
      data: {
        elapsedMs: Date.now() - t0,
        liveCount: result.lives.length,
        debug: result.debug,
      },
    });

    if (userId && result.lives.length > 0) {
      const live = result.lives[0];
      try {
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
        const saved = await prisma.liveSession.upsert({
          where: { roomId: live.roomId },
          create: { userId, roomId: live.roomId, ...payload },
          update: payload,
        });
        trace.push({ step: "db save", ok: true, data: { id: saved.id, roomId: saved.roomId } });
      } catch (e) {
        trace.push({ step: "db save", ok: false, error: (e as Error).message, data: { stack: (e as Error).stack?.slice(0, 800) } });
      }
    }
  } catch (e) {
    trace.push({ step: "scrapeLiveSessions full", ok: false, error: (e as Error).message });
  }

  return NextResponse.json({ trace });
}
