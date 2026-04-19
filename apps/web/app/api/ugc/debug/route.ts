import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { pollFidelityClone } from "@/lib/ugc/fidelity-clone";

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "motionforge2026") {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const view = request.nextUrl.searchParams.get("view");

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
