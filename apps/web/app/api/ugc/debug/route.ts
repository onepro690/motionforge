import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { pollFidelityClone } from "@/lib/ugc/fidelity-clone";
import { finalizeRecording } from "@/lib/ugc/live-recorder";

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "motionforge2026") {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const view = request.nextUrl.searchParams.get("view");

  if (view === "settings-check") {
    const all = await prisma.ugcSystemSettings.findMany({
      select: {
        userId: true,
        tiktokScraperApiKey: true,
        searchKeywords: true,
        updatedAt: true,
      },
    });
    const summary = all.map((s) => ({
      userId: s.userId.slice(0, 8) + "...",
      hasScraperKey: !!s.tiktokScraperApiKey,
      keyPrefix: s.tiktokScraperApiKey ? s.tiktokScraperApiKey.slice(0, 8) + "..." + s.tiktokScraperApiKey.slice(-4) : null,
      keyLength: s.tiktokScraperApiKey?.length ?? 0,
      searchKeywords: s.searchKeywords,
      updatedAt: s.updatedAt,
    }));
    return NextResponse.json({ count: all.length, settings: summary }, { status: 200 });
  }

  if (view === "api23-probe") {
    const handle = request.nextUrl.searchParams.get("handle") ?? "shoptiktokbr";
    const settings = await prisma.ugcSystemSettings.findFirst({ select: { tiktokScraperApiKey: true } });
    const key = settings?.tiktokScraperApiKey;
    if (!key) return NextResponse.json({ error: "no key" }, { status: 400 });
    const host = "tiktok-api23.p.rapidapi.com";
    // Testa múltiplas variantes de path + query param pra Check Alive,
    // Search Live, Get Live Info, Get Live Stream
    const paths = [
      // Check Alive variants
      `/api/live/check-alive?uniqueId=${handle}`,
      `/api/live/check-alive?username=${handle}`,
      `/api/live/check-alive?unique_id=${handle}`,
      `/api/check-alive?uniqueId=${handle}`,
      `/api/live/check_alive?uniqueId=${handle}`,
      `/api/live/alive?uniqueId=${handle}`,
      // Search Live variants
      `/api/search/live?keyword=live`,
      `/api/search/live?keywords=live`,
      `/api/live/search?keyword=live`,
      // Get Live Info
      `/api/live/info?uniqueId=${handle}`,
      `/api/live/info?username=${handle}`,
      // Get Live Stream
      `/api/live/stream?uniqueId=${handle}`,
      // Category
      `/api/live/category`,
      `/api/live/categories`,
    ];
    const out: Array<{ path: string; status: number; bodyPreview: string }> = [];
    for (const p of paths) {
      try {
        const res = await fetch(`https://${host}${p}`, {
          headers: { "x-rapidapi-key": key, "x-rapidapi-host": host, "Accept": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        const body = await res.text();
        out.push({ path: p, status: res.status, bodyPreview: body.slice(0, 800) });
      } catch (e) {
        out.push({ path: p, status: -1, bodyPreview: String(e).slice(0, 200) });
      }
    }
    return NextResponse.json({ handle, host, results: out }, { status: 200 });
  }

  if (view === "tikwm-probe") {
    // Testa se tikwm.com tem endpoint de live detection (sem precisar de key)
    const handle = request.nextUrl.searchParams.get("handle") ?? "shoptiktokbr";
    const paths = [
      `https://www.tikwm.com/api/user/live?unique_id=${handle}`,
      `https://www.tikwm.com/api/live/check?unique_id=${handle}`,
      `https://www.tikwm.com/api/live/info?unique_id=${handle}`,
      `https://www.tikwm.com/api/live/search?keywords=live&region=br`,
      `https://www.tikwm.com/api/live/list?region=br`,
      `https://www.tikwm.com/api/live/recommend?region=br`,
      `https://www.tikwm.com/api/live/popular?region=br`,
      `https://www.tikwm.com/api/user/info?unique_id=${handle}`,
    ];
    const out: Array<{ path: string; status: number; bodyPreview: string }> = [];
    for (const p of paths) {
      try {
        const res = await fetch(p, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(10_000),
        });
        const body = await res.text();
        out.push({ path: p, status: res.status, bodyPreview: body.slice(0, 1500) });
      } catch (e) {
        out.push({ path: p, status: -1, bodyPreview: String(e).slice(0, 200) });
      }
    }
    return NextResponse.json({ handle, results: out }, { status: 200 });
  }

  if (view === "scraper7-ping") {
    // Faz request direto no scraper7 pra ver resposta + rate limit headers
    const handle = request.nextUrl.searchParams.get("handle") ?? "tiktokshop";
    const settings = await prisma.ugcSystemSettings.findFirst({ select: { tiktokScraperApiKey: true } });
    const key = settings?.tiktokScraperApiKey;
    if (!key) return NextResponse.json({ error: "no key" }, { status: 400 });
    const host = "tiktok-scraper7.p.rapidapi.com";
    const paths = [
      `/user/info?unique_id=${handle}`,
      `/user/info/v2?unique_id=${handle}`,
      `/live/check?unique_id=${handle}`,
      `/check/live?unique_id=${handle}`,
      `/live/room?unique_id=${handle}`,
      `/live/search?keywords=live`,
      `/live/list?region=br`,
      `/feed/live?region=br`,
      `/popular/live?region=br`,
      `/recommend/live?region=br`,
      `/endpoints`,
    ];
    const out: Array<{ path: string; status: number; rateLimitHeaders: Record<string, string>; bodyPreview: string }> = [];
    for (const p of paths) {
      try {
        const res = await fetch(`https://${host}${p}`, {
          headers: { "x-rapidapi-key": key, "x-rapidapi-host": host, "Accept": "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        const rateLimitHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          if (k.toLowerCase().includes("rate") || k.toLowerCase().includes("quota") || k.toLowerCase().includes("limit")) {
            rateLimitHeaders[k] = v;
          }
        });
        const body = await res.text();
        out.push({ path: p, status: res.status, rateLimitHeaders, bodyPreview: body.slice(0, 800) });
      } catch (e) {
        out.push({ path: p, status: -1, rateLimitHeaders: {}, bodyPreview: String(e).slice(0, 500) });
      }
    }
    return NextResponse.json({ handle, host, results: out }, { status: 200 });
  }

  if (view === "thumbs") {
    const products = await prisma.ugcTrendingProduct.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, name: true, thumbnailUrl: true },
    });
    return NextResponse.json(products, { status: 200 });
  }

  if (view === "products") {
    const [all, approved, usedForGen] = await Promise.all([
      prisma.ugcTrendingProduct.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, name: true, status: true, score: true, createdAt: true },
      }),
      prisma.ugcTrendingProduct.findMany({
        where: { status: "APPROVED" },
        select: { id: true, name: true, status: true, score: true, createdAt: true },
      }),
      prisma.ugcTrendingProduct.findMany({
        where: { status: "USED_FOR_GENERATION" },
        select: { id: true, name: true, status: true, score: true, createdAt: true },
      }),
    ]);
    const totalCount = await prisma.ugcTrendingProduct.count();
    return NextResponse.json({ totalCount, approved, usedForGen, recent20: all }, { status: 200 });
  }

  if (view === "lives-recording") {
    const { list } = await import("@vercel/blob");
    const lives = await prisma.liveSession.findMany({
      where: { recordingStatus: { in: ["QUEUED", "RECORDING", "DONE", "FAILED"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true, roomId: true, hostHandle: true, isLive: true,
        recordingStatus: true, recordingUrl: true, recordingError: true,
        recordingStartedAt: true, recordingEndedAt: true, recordingLockedUntil: true,
        recordingDurationSeconds: true, updatedAt: true,
      },
    });
    // Conta chunks no Blob pra cada live
    const withChunks = await Promise.all(
      lives.map(async (l) => {
        try {
          const listing = await list({ prefix: `ugc/lives/${l.id}/chunks/` });
          return { ...l, chunkCount: listing.blobs.length, chunkUrls: listing.blobs.map((b) => b.url).slice(0, 5) };
        } catch {
          return { ...l, chunkCount: -1, chunkUrls: [] };
        }
      }),
    );
    return NextResponse.json(withChunks, { status: 200 });
  }

  if (view === "videos-products") {
    const videos = await prisma.ugcGeneratedVideo.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        createdAt: true,
        productId: true,
        product: { select: { id: true, name: true, status: true } },
      },
    });
    return NextResponse.json(videos, { status: 200 });
  }

  const recentVideos = await prisma.ugcGeneratedVideo.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      currentStep: true,
      errorMessage: true,
      createdAt: true,
      script: true,
      takes: {
        orderBy: { takeIndex: "asc" },
        select: { takeIndex: true, status: true, videoUrl: true, errorMessage: true },
      },
      logs: {
        orderBy: { createdAt: "asc" },
        select: { step: true, status: true, message: true, createdAt: true },
      },
    },
  });

  return NextResponse.json(recentVideos, { status: 200 });
}

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "motionforge2026") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const action = request.nextUrl.searchParams.get("action");
  const videoId = request.nextUrl.searchParams.get("videoId");
  if (!videoId) return NextResponse.json({ error: "videoId required" }, { status: 400 });

  if (action === "recover-fidelity") {
    const video = await prisma.ugcGeneratedVideo.findUnique({
      where: { id: videoId },
      select: { id: true, status: true, currentStep: true },
    });
    if (!video) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!video.currentStep?.startsWith("fidelity_clone_processing_")) {
      return NextResponse.json({ error: "no fidelity request_id in currentStep", currentStep: video.currentStep }, { status: 400 });
    }
    const updated = await prisma.ugcGeneratedVideo.update({
      where: { id: videoId },
      data: {
        status: "GENERATING_TAKES",
        errorMessage: null,
        generationStartedAt: new Date(),
      },
      select: { id: true, status: true, currentStep: true, generationStartedAt: true },
    });
    return NextResponse.json({ recovered: updated }, { status: 200 });
  }

  if (action === "mark-live-done") {
    // Quando finalize gerou o final.mp4 e fez upload mas timed out antes
    // do update DB. recordingUrl já está presente, só falta marcar DONE.
    const live = await prisma.liveSession.findUnique({
      where: { id: videoId },
      select: { recordingUrl: true },
    });
    if (!live?.recordingUrl) {
      return NextResponse.json({ error: "sem recordingUrl — rode retry-finalize-live" }, { status: 400 });
    }
    const updated = await prisma.liveSession.update({
      where: { id: videoId },
      data: { recordingStatus: "DONE", recordingError: null, recordingEndedAt: new Date() },
      select: { recordingStatus: true, recordingUrl: true },
    });
    return NextResponse.json({ updated }, { status: 200 });
  }

  if (action === "retry-finalize-live") {
    // Reseta status pra RECORDING e chama finalizeRecording de novo.
    // Usa os chunks que ainda estão no Blob.
    await prisma.liveSession.update({
      where: { id: videoId },
      data: { recordingStatus: "RECORDING", recordingError: null },
    });
    const result = await finalizeRecording(videoId);
    const after = await prisma.liveSession.findUnique({
      where: { id: videoId },
      select: { recordingStatus: true, recordingUrl: true, recordingError: true },
    });
    return NextResponse.json({ result, after }, { status: 200 });
  }

  if (action === "poll-now") {
    const r = await pollFidelityClone(videoId);
    const after = await prisma.ugcGeneratedVideo.findUnique({
      where: { id: videoId },
      select: { status: true, currentStep: true, errorMessage: true, finalVideoUrl: true },
    });
    return NextResponse.json({ pollResult: r, after }, { status: 200 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
