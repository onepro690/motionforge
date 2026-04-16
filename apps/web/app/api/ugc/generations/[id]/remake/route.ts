import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { runVideoPipeline } from "@/lib/ugc/pipeline";
import { recordFeedbackPattern } from "@/lib/ugc/anti-repeat";
import { z } from "zod";

export const maxDuration = 60;

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

  // Create new version
  const newVideo = await prisma.ugcGeneratedVideo.create({
    data: {
      userId,
      productId: original.productId,
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

  // Run pipeline async with remake context
  runVideoPipeline(newVideo.id, { feedback, previousVideoId: id }).catch((err) => {
    console.error(`[ugc/remake] Pipeline failed for video ${newVideo.id}:`, err);
  });

  return NextResponse.json({ success: true, newVideoId: newVideo.id });
}
