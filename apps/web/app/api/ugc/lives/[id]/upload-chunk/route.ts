// Client direct-upload pro Vercel Blob. O endpoint NÃO recebe o bytes do
// chunk — apenas emite um signed URL via `handleUpload`. O browser faz
// PUT direto pro Blob, contornando o limite de 4.5MB de body de serverless
// functions (chunks webm de 30s podem passar de 9MB).
//
// `onBeforeGenerateToken` valida autenticação + dono + path antes de emitir
// o token. `onUploadCompleted` é chamado pelo Vercel após o upload, e é
// onde atualizamos o DB (status RECORDING + increment de duração).
//
// ⚠ `onUploadCompleted` requer URL pública (produção). Localhost não
// recebe o callback — em dev só os chunks são salvos, sem metadata.

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export const runtime = "nodejs";
export const maxDuration = 30;

interface ClientPayload {
  index: number;
  durationMs: number;
  startedAtMs: number;
}

interface TokenPayload extends ClientPayload {
  sessionId: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayloadStr) => {
        const session = await auth.api.getSession({ headers: await headers() });
        if (!session) throw new Error("unauthorized");
        const live = await prisma.liveSession.findUnique({ where: { id } });
        if (!live || live.userId !== session.user.id) throw new Error("not_found");
        if (live.recordingStatus === "DONE" || live.recordingStatus === "FAILED") {
          throw new Error("already_finalized");
        }
        if (
          !pathname.startsWith(`ugc/lives/${id}/chunks/`) ||
          !pathname.endsWith(".webm.part")
        ) {
          throw new Error("bad_path");
        }
        const payload = clientPayloadStr
          ? (JSON.parse(clientPayloadStr) as ClientPayload)
          : { index: 0, durationMs: 0, startedAtMs: Date.now() };
        const tokenPayload: TokenPayload = { sessionId: id, ...payload };
        return {
          allowedContentTypes: ["video/webm"],
          addRandomSuffix: false,
          allowOverwrite: true,
          tokenPayload: JSON.stringify(tokenPayload),
        };
      },
      onUploadCompleted: async ({ tokenPayload }) => {
        if (!tokenPayload) return;
        const data = JSON.parse(tokenPayload) as TokenPayload;
        const chunkSeconds = Math.max(
          0,
          Math.round((data.durationMs || 0) / 1000),
        );
        if (data.index === 0) {
          await prisma.liveSession.updateMany({
            where: {
              id: data.sessionId,
              recordingStatus: { in: ["NONE", "QUEUED", "RECORDING"] },
            },
            data: {
              recordingStatus: "RECORDING",
              recordingStartedAt: new Date(data.startedAtMs),
              recordingError: null,
            },
          });
        }
        if (chunkSeconds > 0) {
          await prisma.liveSession.updateMany({
            where: {
              id: data.sessionId,
              recordingStatus: { in: ["NONE", "QUEUED", "RECORDING"] },
            },
            data: {
              recordingDurationSeconds: { increment: chunkSeconds },
            },
          });
        }
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
