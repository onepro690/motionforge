// Client-side loop endpoint: grava 1 chunk (ou finaliza) por chamada.
// Usado quando o usuário abre a página e dispara gravação ao vivo.
// Em paralelo, /api/cron/record-lives roda a cada 2min garantindo que
// a gravação continue mesmo com a aba fechada.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { recordChunk, finalizeRecording } from "@/lib/ugc/live-recorder";

export const maxDuration = 300;
export const runtime = "nodejs";

interface Body {
  durationSeconds?: number;
  finalize?: boolean;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = ((await req.json().catch(() => ({}))) as Body) || {};

  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live || live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.finalize) {
    const result = await finalizeRecording(id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: "message" in result ? result.message : undefined },
        { status: 400 },
      );
    }
    const { updated } = result;
    return NextResponse.json({
      success: true,
      finalUrl: result.finalUrl,
      chunks: result.chunks,
      session: {
        ...updated,
        likeCount: Number(updated.likeCount),
        totalViewers: Number(updated.totalViewers),
      },
    });
  }

  const result = await recordChunk(id, body.durationSeconds ?? 240);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message, stillLive: result.stillLive },
      { status: result.error === "no_stream_url" ? 400 : 500 },
    );
  }

  return NextResponse.json({
    success: true,
    chunkUrl: result.chunkUrl,
    chunkSeconds: result.chunkSeconds,
    cumulativeSeconds: result.cumulativeSeconds,
    stillLive: result.stillLive,
  });
}
