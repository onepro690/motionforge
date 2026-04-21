import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { confirmLiveEnded } from "@/lib/ugc/live-scraper";

// Chamado pelo recorder provider a cada ~60s durante gravação pra decidir
// se a live do TikTok encerrou. Usa confirmLiveEnded (status JSON + HLS
// proof-of-life, duas janelas separadas por 15s) — só retorna ended=true
// se realmente acabou, nunca falso-positivo por reconnect curto.

export const runtime = "nodejs";
export const maxDuration = 45;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const live = await prisma.liveSession.findUnique({
    where: { id },
    select: { userId: true, roomId: true, isLive: true },
  });
  if (!live || live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!live.roomId || !/^\d{15,}$/.test(live.roomId)) {
    // Sem roomId real (entrada manual/placeholder) — não dá pra checar.
    return NextResponse.json({ alive: true, unknown: true });
  }

  const ended = await confirmLiveEnded(live.roomId);
  if (ended) {
    await prisma.liveSession.update({
      where: { id },
      data: { isLive: false, endedAt: new Date() },
    });
  }
  return NextResponse.json({ alive: !ended });
}
