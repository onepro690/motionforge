import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { runVideoPipeline } from "@/lib/ugc/pipeline";
import { recordFeedbackPattern } from "@/lib/ugc/anti-repeat";
import { z } from "zod";

// Pipeline completo roda em background via after(); o route só precisa
// criar o registro e retornar. Mesmo assim bump pra 300 pra cobrir
// o parseRemakeFeedback (LLM call) inicial que acontece dentro do pipeline.
export const maxDuration = 300;
export const runtime = "nodejs";

const schema = z.object({
  feedback: z.string().min(3).max(1000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const userId = session.user.id;

  const original = await prisma.ugcGeneratedVideo.findUnique({ where: { id } });
  if (!original || original.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Feedback obrigatório" }, { status: 400 });

  const { feedback } = parsed.data;

  // Mark original as REMAKE_REQUESTED
  await prisma.ugcGeneratedVideo.update({
    where: { id },
    data: { status: "REMAKE_REQUESTED" },
  });

  // Save remake request
  const remakeReq = await prisma.ugcRemakeRequest.create({
    data: { videoId: id, userId, feedback, status: "processing" },
  });

  // Create new version — herda characterId do original (mantém o mesmo avatar
  // pra que a refação não troque a pessoa inesperadamente).
  const newVideo = await prisma.ugcGeneratedVideo.create({
    data: {
      userId,
      productId: original.productId,
      characterId: original.characterId,
      status: "DRAFT_GENERATED",
      version: original.version + 1,
      parentVideoId: id,
      title: `${original.title ?? "Vídeo"} (Refação v${original.version + 1})`,
      currentStep: "queued",
    },
  });

  // Update remake request with new video id
  await prisma.ugcRemakeRequest.update({
    where: { id: remakeReq.id },
    data: { newVideoId: newVideo.id },
  });

  // Update original to REGENERATING
  await prisma.ugcGeneratedVideo.update({
    where: { id },
    data: { status: "REGENERATING" },
  });

  // Record negative feedback pattern
  await recordFeedbackPattern(userId, feedback.slice(0, 100), "general", "negative");

  // Run pipeline em background. after() garante que o Vercel mantém o
  // worker vivo até terminar (diferente do fire-and-forget com .catch).
  after(async () => {
    try {
      console.log(`[ugc/remake] Starting pipeline for video ${newVideo.id}...`);
      await runVideoPipeline(newVideo.id, { feedback, previousVideoId: id });
      console.log(`[ugc/remake] Pipeline completed for video ${newVideo.id}`);
    } catch (err) {
      console.error(`[ugc/remake] Pipeline failed for video ${newVideo.id}:`, err);
      await prisma.ugcGeneratedVideo.update({
        where: { id: newVideo.id },
        data: {
          status: "FAILED",
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      }).catch(() => null);
    }
  });

  return NextResponse.json({ success: true, newVideoId: newVideo.id });
}
