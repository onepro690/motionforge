// Browser-based recording: cliente grava a aba da live via getDisplayMedia +
// MediaRecorder e faz upload de cada chunk webm aqui. Cada chunk vira
// `ugc/lives/{id}/chunks/{index}.webm.part`. O finalize concatena binariamente
// (WebM com timeslice produz chunks que são pedaços válidos do mesmo stream).
//
// maxDuration baixo — upload é rápido (< 30s por chunk de 30s).

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (live.recordingStatus === "DONE" || live.recordingStatus === "FAILED") {
    return NextResponse.json({ error: "already_finalized" }, { status: 409 });
  }

  const form = await req.formData();
  const file = form.get("chunk");
  const indexRaw = form.get("index");
  const durationMsRaw = form.get("durationMs");

  if (!(file instanceof Blob) || typeof indexRaw !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const index = Number(indexRaw);
  if (!Number.isFinite(index) || index < 0 || index > 999_999) {
    return NextResponse.json({ error: "bad_index" }, { status: 400 });
  }
  if (file.size < 1_000) {
    return NextResponse.json({ error: "empty_chunk" }, { status: 400 });
  }

  const durationMs = typeof durationMsRaw === "string" ? Number(durationMsRaw) : 0;
  const chunkSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));

  const padded = String(index).padStart(6, "0");
  const key = `ugc/lives/${id}/chunks/${padded}.webm.part`;
  const buf = Buffer.from(await file.arrayBuffer());

  const blob = await put(key, buf, {
    access: "public",
    contentType: "video/webm",
    allowOverwrite: true,
  });

  // Primeira chamada: marca RECORDING + startedAt. Chamadas subsequentes só
  // incrementam duração. Usamos updateMany pra evitar sobrescrever DONE caso
  // chegue um upload atrasado.
  if (index === 0) {
    await prisma.liveSession.updateMany({
      where: {
        id,
        recordingStatus: { in: ["NONE", "QUEUED", "RECORDING"] },
      },
      data: {
        recordingStatus: "RECORDING",
        recordingStartedAt: live.recordingStartedAt ?? new Date(),
        recordingError: null,
      },
    });
  }

  if (chunkSeconds > 0) {
    await prisma.liveSession.updateMany({
      where: {
        id,
        recordingStatus: { in: ["NONE", "QUEUED", "RECORDING"] },
      },
      data: {
        recordingDurationSeconds: { increment: chunkSeconds },
      },
    });
  }

  return NextResponse.json({
    success: true,
    chunkUrl: blob.url,
    index,
    size: buf.length,
  });
}
