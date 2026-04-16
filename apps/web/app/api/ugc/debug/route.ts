import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const recentVideos = await prisma.ugcGeneratedVideo.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: {
      id: true,
      status: true,
      currentStep: true,
      errorMessage: true,
      createdAt: true,
      veoPrompts: true,
      script: true,
      copyByTake: true,
      takes: {
        orderBy: { takeIndex: "asc" },
        select: { takeIndex: true, status: true, videoUrl: true, veoPrompt: true, errorMessage: true },
      },
      logs: {
        orderBy: { createdAt: "asc" },
        select: { step: true, status: true, message: true, data: true, createdAt: true },
      },
    },
  });

  return NextResponse.json(recentVideos, { status: 200 });
}
