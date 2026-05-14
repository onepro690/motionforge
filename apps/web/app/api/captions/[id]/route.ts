import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const job = await prisma.generationJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (job.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (job.provider !== "captions") {
      return NextResponse.json({ error: "Job não é de legendas" }, { status: 400 });
    }

    let meta: { language?: string | null; wordsCount?: number; linesCount?: number; durationSeconds?: number } | null = null;
    if (job.generatedPrompt) {
      try { meta = JSON.parse(job.generatedPrompt); } catch { /* ignore */ }
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
      outputVideoUrl: job.outputVideoUrl,
      inputVideoUrl: job.inputVideoUrl,
      errorMessage: job.errorMessage,
      durationSeconds: job.inputVideoDuration ?? meta?.durationSeconds ?? null,
      language: meta?.language ?? null,
      wordsCount: meta?.wordsCount ?? null,
      linesCount: meta?.linesCount ?? null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    console.error("[captions/[id]] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 },
    );
  }
}
