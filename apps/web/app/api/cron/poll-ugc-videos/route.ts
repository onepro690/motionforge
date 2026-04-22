// Cron: poll Vertex AI operations pra vídeos UGC em GENERATING_TAKES e
// avança o pipeline (assembly) quando todos os takes terminam.
// Também lida com fidelity clone (Fal queue) — detectado via transitionMode.
//
// Sem este cron, videos ficam presos aguardando alguém abrir a página
// individual (que dispara pollAndAssembleTakes).
//
// Schedule: a cada 2min. maxDuration 300s dá margem pra processar 5-10
// videos por execução (cada poll ~10-30s).

import { NextResponse } from "next/server";
import { prisma } from "@motion/database";
import { pollAndAssembleTakes } from "@/lib/ugc/pipeline";
import { pollFidelityClone, isFidelityClone } from "@/lib/ugc/fidelity-clone";
import { pollFaceSwapJob, startFaceSwapJob } from "@/lib/ugc/face-swap";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = await prisma.ugcGeneratedVideo.findMany({
    where: { status: "GENERATING_TAKES" },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true, transitionMode: true },
  });

  const faceSwapQueued = await prisma.faceSwapJob.findMany({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true },
  });

  const faceSwapPending = await prisma.faceSwapJob.findMany({
    where: { status: "PROCESSING" },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });

  const results: Array<{ id: string; kind: string; status: string; ok: boolean; error?: string }> = [];
  for (const v of pending) {
    try {
      if (isFidelityClone(v)) {
        const r = await pollFidelityClone(v.id);
        results.push({ id: v.id, kind: "fidelity", status: r.status, ok: true });
      } else {
        const r = await pollAndAssembleTakes(v.id);
        results.push({ id: v.id, kind: "takes", status: r.status, ok: true });
      }
    } catch (err) {
      results.push({
        id: v.id,
        kind: "ugc",
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Se algum job ficou em QUEUED (ex: POST bateu timeout antes de submeter),
  // retoma a submissão no cron.
  for (const j of faceSwapQueued) {
    try {
      await startFaceSwapJob(j.id);
      results.push({ id: j.id, kind: "face-swap-submit", status: "ok", ok: true });
    } catch (err) {
      results.push({
        id: j.id,
        kind: "face-swap-submit",
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const j of faceSwapPending) {
    try {
      const r = await pollFaceSwapJob(j.id);
      results.push({ id: j.id, kind: "face-swap", status: r.status, ok: true });
    } catch (err) {
      results.push({
        id: j.id,
        kind: "face-swap",
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    processed: pending.length + faceSwapQueued.length + faceSwapPending.length,
    results,
  });
}
