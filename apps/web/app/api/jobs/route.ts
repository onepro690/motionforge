import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getMotionQueue } from "@/lib/queue";
import { z } from "zod";

const createJobSchema = z.object({
  inputVideoUrl: z.string(),
  inputImageUrl: z.string(),
  aspectRatio: z
    .enum(["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3"])
    .default("RATIO_16_9"),
  resolution: z
    .enum(["SD_480", "HD_720", "FHD_1080"])
    .default("HD_720"),
  maxDuration: z.number().min(3).max(30).default(15),
  motionStrength: z.number().min(0).max(1).default(0.8),
  identityStrength: z.number().min(0).max(1).default(0.9),
  facePreserveStrength: z.number().min(0).max(1).default(0.85),
  backgroundMode: z
    .enum(["KEEP", "REMOVE", "BLUR", "REPLACE"])
    .default("KEEP"),
});

export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") ?? "1");
    const limit = parseInt(searchParams.get("limit") ?? "10");
    const status = searchParams.get("status");

    const jobs = await prisma.generationJob.findMany({
      where: {
        userId: session.user.id,
        ...(status
          ? {
              status:
                status as
                  | "QUEUED"
                  | "PROCESSING"
                  | "RENDERING"
                  | "COMPLETED"
                  | "FAILED",
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: (page - 1) * limit,
    });

    return NextResponse.json(jobs);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch jobs" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.errors },
        { status: 400 }
      );
    }

    const data = parsed.data;
    const provider = process.env.AI_PROVIDER ?? "mock";

    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "QUEUED",
        provider,
        inputVideoUrl: data.inputVideoUrl,
        inputImageUrl: data.inputImageUrl,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        maxDuration: data.maxDuration,
        motionStrength: data.motionStrength,
        identityStrength: data.identityStrength,
        facePreserveStrength: data.facePreserveStrength,
        backgroundMode: data.backgroundMode,
      },
    });

    const queue = getMotionQueue();
    await queue.add(
      "motion-job",
      {
        jobId: job.id,
        userId: session.user.id,
        inputVideoUrl: data.inputVideoUrl,
        inputImageUrl: data.inputImageUrl,
        provider,
        config: {
          aspectRatio: data.aspectRatio,
          resolution: data.resolution,
          maxDuration: data.maxDuration,
          motionStrength: data.motionStrength,
          identityStrength: data.identityStrength,
          facePreserveStrength: data.facePreserveStrength,
          backgroundMode: data.backgroundMode,
        },
      },
      { jobId: job.id }
    );

    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    console.error("Create job error:", error);
    return NextResponse.json(
      { error: "Failed to create job" },
      { status: 500 }
    );
  }
}
