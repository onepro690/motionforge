import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getMotionQueue } from "@/lib/queue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteContext) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const job = await prisma.generationJob.findFirst({
      where: { id, userId: session.user.id },
    });

    if (!job)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!["QUEUED", "PROCESSING", "RENDERING"].includes(job.status))
      return NextResponse.json(
        { error: "Job is not active" },
        { status: 400 }
      );

    // Remove from BullMQ queue (works for QUEUED jobs)
    try {
      const queue = getMotionQueue();
      const bullJob = await queue.getJob(id);
      if (bullJob) await bullJob.remove();
    } catch {
      // Ignore — job may already be processing
    }

    // Mark as cancelled in DB
    await prisma.generationJob.update({
      where: { id },
      data: {
        status: "FAILED",
        errorMessage: "Cancelado pelo usuário",
        completedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to cancel job" },
      { status: 500 }
    );
  }
}
