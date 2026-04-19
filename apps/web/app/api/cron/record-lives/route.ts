// Cron que garante gravação em background mesmo sem aba aberta.
//
// A cada 2min: busca sessions RECORDING sem lock ativo, grava 1 chunk
// (até 270s), e finaliza automaticamente se a live encerrou.
//
// Lock: `recordingLockedUntil` evita que duas execuções (cron + client ou
// cron + cron) peguem a mesma session em paralelo. recordChunk() seta o
// lock antes do ffmpeg e limpa depois.
//
// Autenticação: Vercel Cron envia header `authorization: Bearer $CRON_SECRET`.

import { NextResponse, after } from "next/server";
import { prisma } from "@motion/database";
import { recordChunk, finalizeRecording } from "@/lib/ugc/live-recorder";
import { isLiveActive } from "@/lib/ugc/live-scraper";

export const maxDuration = 300;
export const runtime = "nodejs";

function triggerChain(id: string, cronSecret: string) {
  const baseUrl =
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  after(async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${baseUrl}/api/ugc/lives/${id}/record-now`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({ chained: true }),
        signal: controller.signal,
      });
    } catch {
      /* expected abort */
    } finally {
      clearTimeout(t);
    }
  });
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  // Sessions em RECORDING, sem lock ativo, ordenadas pela mais antiga.
  // Limite 1 por execução pra não estourar 300s (1 chunk = ~240s).
  const candidates = await prisma.liveSession.findMany({
    where: {
      recordingStatus: "RECORDING",
      OR: [
        { recordingLockedUntil: null },
        { recordingLockedUntil: { lt: now } },
      ],
    },
    orderBy: { recordingStartedAt: "asc" },
    take: 1,
  });

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  const target = candidates[0];

  // Checa se ainda está live antes de gastar 240s gravando lixo.
  const stillLive = target.roomId ? await isLiveActive(target.roomId) : false;

  if (!stillLive) {
    const result = await finalizeRecording(target.id);
    return NextResponse.json({
      ok: true,
      processed: 1,
      action: "finalized",
      sessionId: target.id,
      result,
    });
  }

  const chunk = await recordChunk(target.id, 200);

  // Se a live acabou durante este chunk, finaliza já.
  if (chunk.ok && !chunk.stillLive) {
    const finalResult = await finalizeRecording(target.id);
    return NextResponse.json({
      ok: true,
      processed: 1,
      action: "chunk+finalized",
      sessionId: target.id,
      chunk,
      finalResult,
    });
  }

  // Chunk ok e live ainda rolando: reinicia o chain (caso tenha quebrado).
  if (chunk.ok && chunk.stillLive && expected) {
    triggerChain(target.id, expected);
  }

  return NextResponse.json({
    ok: true,
    processed: 1,
    action: "chunk",
    sessionId: target.id,
    chunk,
  });
}
