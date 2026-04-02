import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getMotionQueue } from "@/lib/queue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  _req: NextRequest,
  { params }: RouteContext
) {
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
    if (job.status !== "FAILED") {
      return NextResponse.json(
        { error: "Only failed jobs can be retried" },
        { status: 400 }
      );
    }

    const updated = await prisma.generationJob.update({
      where: { id },
      data: {
        status: "QUEUED",
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        outputVideoUrl: null,
        outputThumbnailUrl: null,
      },
    });

    const queue = getMotionQueue();
    await queue.add(
      "motion-job",
      {
        jobId: job.id,
        userId: session.user.id,
        inputVideoUrl: job.inputVideoUrl,
        inputImageUrl: job.inputImageUrl,
        provider: job.provider,
        config: {
          aspectRatio: job.aspectRatio,
          resolution: job.resolution,
          maxDuration: job.maxDuration,
          motionStrength: job.motionStrength,
          identityStrength: job.identityStrength,
          facePreserveStrength: job.facePreserveStrength,
          backgroundMode: job.backgroundMode,
        },
      },
      { jobId: `${job.id}-retry-${Date.now()}` }
    );

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Failed to retry job" },
      { status: 500 }
    );
  }
}
