import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== "motionforge2026") {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const view = request.nextUrl.searchParams.get("view");

  if (view === "products") {
    const products = await prisma.ugcTrendingProduct.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, name: true, status: true, score: true, createdAt: true },
    });
    return NextResponse.json(products, { status: 200 });
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
