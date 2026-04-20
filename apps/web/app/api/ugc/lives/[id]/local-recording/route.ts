// Gravação local (File System Access API): o browser escreve o arquivo
// direto no disco do usuário. Este endpoint só mantém metadata no DB
// (status, duração, nome do arquivo) pra o dashboard poder listar o que
// foi gravado.
//
// Zero bytes do vídeo passam pelo servidor — não há limite de tamanho nem
// custo de storage no Blob.
//
// Eventos:
//  - "start":    marca RECORDING, recordingStartedAt, recordingUrl=local:<fileName>
//  - "progress": atualiza recordingDurationSeconds (chamado a cada chunk)
//  - "stop":    marca DONE + recordingEndedAt
//  - "cancel":  volta pra NONE (usuário cancelou o diálogo de salvar)

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export const runtime = "nodejs";
export const maxDuration = 15;

interface Body {
  event: "start" | "progress" | "stop" | "cancel";
  fileName?: string;
  durationSeconds?: number;
}

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
  if (!live || live.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || !body.event) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.event === "start") {
    const fileName = (body.fileName || "recording.webm").slice(0, 200);
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "RECORDING",
        recordingStartedAt: new Date(),
        recordingEndedAt: null,
        recordingDurationSeconds: 0,
        recordingUrl: `local:${fileName}`,
        recordingError: null,
        recordingLockedUntil: null,
      },
    });
    return NextResponse.json({ success: true });
  }

  if (body.event === "progress") {
    const seconds = Math.max(0, Math.floor(body.durationSeconds ?? 0));
    await prisma.liveSession.updateMany({
      where: {
        id,
        recordingStatus: "RECORDING",
      },
      data: {
        recordingDurationSeconds: seconds,
      },
    });
    return NextResponse.json({ success: true });
  }

  if (body.event === "stop") {
    const seconds = Math.max(0, Math.floor(body.durationSeconds ?? 0));
    await prisma.liveSession.updateMany({
      where: {
        id,
        recordingStatus: "RECORDING",
      },
      data: {
        recordingStatus: "DONE",
        recordingEndedAt: new Date(),
        recordingDurationSeconds: seconds,
        recordingLockedUntil: null,
      },
    });
    return NextResponse.json({ success: true });
  }

  if (body.event === "cancel") {
    await prisma.liveSession.updateMany({
      where: {
        id,
        recordingStatus: { in: ["QUEUED", "RECORDING"] },
      },
      data: {
        recordingStatus: "NONE",
        recordingStartedAt: null,
        recordingEndedAt: null,
        recordingDurationSeconds: null,
        recordingUrl: null,
        recordingError: null,
        recordingLockedUntil: null,
      },
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "bad_event" }, { status: 400 });
}
