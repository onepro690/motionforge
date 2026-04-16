import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { recordFeedbackPattern } from "@/lib/ugc/anti-repeat";
import { z } from "zod";

const schema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const userId = session.user.id;

  const video = await prisma.ugcGeneratedVideo.findUnique({ where: { id } });
  if (!video || video.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { decision, notes } = parsed.data;
  const newStatus = decision === "APPROVED" ? "COMPLETED" : "REJECTED";

  await prisma.ugcVideoReview.create({
    data: { videoId: id, userId, decision, notes: notes ?? null },
  });

  await prisma.ugcGeneratedVideo.update({
    where: { id },
    data: { status: newStatus, reviewedAt: new Date(), reviewNotes: notes ?? null },
  });

  // Record feedback patterns
  if (decision === "APPROVED" && video.creativeBriefSnapshot) {
    const brief = video.creativeBriefSnapshot as Record<string, string>;
    if (brief.angle) await recordFeedbackPattern(userId, brief.angle, "angle", "positive");
    if (brief.tone) await recordFeedbackPattern(userId, brief.tone, "tone", "positive");
  } else if (decision === "REJECTED" && notes) {
    await recordFeedbackPattern(userId, notes.slice(0, 100), "general", "negative");
  }

  return NextResponse.json({ success: true, status: newStatus });
}
