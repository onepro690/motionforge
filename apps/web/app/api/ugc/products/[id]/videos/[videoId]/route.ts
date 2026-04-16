import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; videoId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, videoId } = await params;

  const video = await prisma.ugcDetectedVideo.findUnique({ where: { id: videoId } });
  if (!video || video.userId !== session.user.id || video.productId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.ugcDetectedVideo.delete({ where: { id: videoId } });

  // Atualiza contador
  await prisma.ugcTrendingProduct.update({
    where: { id },
    data: { detectedVideoCount: { decrement: 1 } },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
