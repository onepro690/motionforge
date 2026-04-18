import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";
import { pollAndAssembleTakes, regenerateSingleTake } from "@/lib/ugc/pipeline";

export const maxDuration = 120;
export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["remove", "restore", "regenerate"]),
  feedback: z.string().max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; takeId: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, takeId } = await params;
  const userId = session.user.id;

  const take = await prisma.ugcGeneratedTake.findUnique({
    where: { id: takeId },
    include: { video: { select: { id: true, userId: true, status: true } } },
  });
  if (!take || take.video.id !== id || take.video.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  const { action, feedback } = parsed.data;

  if (action === "remove") {
    await prisma.ugcGeneratedTake.update({
      where: { id: takeId },
      data: { excluded: true },
    });
  } else if (action === "restore") {
    await prisma.ugcGeneratedTake.update({
      where: { id: takeId },
      data: { excluded: false },
    });
  } else if (action === "regenerate") {
    await prisma.ugcGeneratedTake.update({
      where: { id: takeId },
      data: {
        status: "QUEUED",
        videoUrl: null,
        lastFrameUrl: null,
        errorMessage: null,
        retryCount: 0,
        excluded: false,
        regenerationFeedback: feedback?.trim() || null,
      },
    });
  }

  // Após mudar: força status do vídeo pra GENERATING_TAKES ou coloca em
  // REASSEMBLING pra disparar re-merge. O pipeline pollAndAssemble cuida do resto.
  const remainingQueued = await prisma.ugcGeneratedTake.count({
    where: { videoId: id, status: { in: ["QUEUED", "PROCESSING"] } },
  });

  if (remainingQueued > 0) {
    // Volta pra GENERATING_TAKES — polling vai submeter o(s) take(s) e remontar
    await prisma.ugcGeneratedVideo.update({
      where: { id },
      data: { status: "GENERATING_TAKES", finalVideoUrl: null },
    });
    // Dispara regeneração em background se for regenerate
    if (action === "regenerate") {
      after(async () => {
        try {
          await regenerateSingleTake(id, takeId, feedback?.trim() || null);
          await pollAndAssembleTakes(id);
        } catch (err) {
          console.error(`[takes/${takeId}] regenerate failed:`, err);
        }
      });
    } else {
      // remove/restore só → mesmo assim tenta avançar
      after(async () => {
        try {
          await pollAndAssembleTakes(id);
        } catch (err) {
          console.error(`[takes/${takeId}] poll after ${action} failed:`, err);
        }
      });
    }
  } else {
    // Nenhum take pendente — só precisa remontar
    await prisma.ugcGeneratedVideo.update({
      where: { id },
      data: { status: "GENERATING_TAKES", finalVideoUrl: null },
    });
    after(async () => {
      try {
        await pollAndAssembleTakes(id);
      } catch (err) {
        console.error(`[takes/${takeId}] re-assemble failed:`, err);
      }
    });
  }

  return NextResponse.json({ ok: true, action });
}
