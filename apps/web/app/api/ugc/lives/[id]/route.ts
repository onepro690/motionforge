import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { del } from "@vercel/blob";

// PATCH /api/ugc/lives/[id] — marca para gravação ou atualiza status
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json() as { action?: string; recordingStatus?: string; recordingUrl?: string; recordingError?: string };

  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live || live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.action === "queue_recording") {
    if (!live.hlsUrl && !live.flvUrl) {
      return NextResponse.json({ error: "no_stream_url", message: "Esta live não tem URL de stream disponível. Faça um novo scrape enquanto está ao vivo." }, { status: 400 });
    }
    await prisma.liveSession.update({
      where: { id },
      data: { recordingStatus: "QUEUED" },
    });
    return NextResponse.json({ success: true, status: "QUEUED" });
  }

  if (body.action === "cancel_recording") {
    await prisma.liveSession.update({
      where: { id },
      data: { recordingStatus: "NONE" },
    });
    return NextResponse.json({ success: true, status: "NONE" });
  }

  if (body.action === "delete_recording") {
    if (live.recordingUrl) {
      await del(live.recordingUrl).catch(() => null);
    }
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "NONE",
        recordingUrl: null,
        recordingError: null,
        recordingStartedAt: null,
        recordingEndedAt: null,
        recordingDurationSeconds: null,
      },
    });
    return NextResponse.json({ success: true });
  }

  // Atualização de status vinda do recorder local
  const data: Record<string, unknown> = {};
  if (body.recordingStatus) data.recordingStatus = body.recordingStatus;
  if (body.recordingUrl)    data.recordingUrl    = body.recordingUrl;
  if (body.recordingError)  data.recordingError  = body.recordingError;
  if (body.recordingStatus === "RECORDING") data.recordingStartedAt = new Date();
  if (body.recordingStatus === "DONE" || body.recordingStatus === "FAILED") data.recordingEndedAt = new Date();

  const updated = await prisma.liveSession.update({ where: { id }, data });
  return NextResponse.json({
    success: true,
    session: {
      ...updated,
      likeCount:    Number(updated.likeCount),
      totalViewers: Number(updated.totalViewers),
    },
  });
}

// DELETE /api/ugc/lives/[id] — apaga a live inteira + gravação do Blob
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live || live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (live.recordingUrl) {
    await del(live.recordingUrl).catch(() => null);
  }
  await prisma.liveSession.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
