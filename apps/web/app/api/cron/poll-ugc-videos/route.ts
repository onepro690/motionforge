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

  const results: Array<{ id: string; status: string; ok: boolean; error?: string }> = [];
  for (const v of pending) {
    try {
      if (isFidelityClone(v)) {
        const r = await pollFidelityClone(v.id);
        results.push({ id: v.id, status: r.status, ok: true });
      } else {
        const r = await pollAndAssembleTakes(v.id);
        results.push({ id: v.id, status: r.status, ok: true });
      }
    } catch (err) {
      results.push({
        id: v.id,
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ processed: pending.length, results });
}
