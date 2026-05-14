import { type NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";
import { runCaptionsPipeline } from "@/lib/captions/pipeline";

export const maxDuration = 300;

const schema = z.object({
  videoUrl: z.string().url(),
  position: z.number().min(0).max(100).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Entrada inválida", details: parsed.error.errors }, { status: 400 });
    }
    const { videoUrl, position } = parsed.data;

    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: "captions",
        inputVideoUrl: videoUrl,
        inputImageUrl: "",
        aspectRatio: "RATIO_9_16",
        startedAt: new Date(),
      },
    });

    // Dispara pipeline em background — função continua viva até o handler do
    // after() retornar (maxDuration=300 cobre vídeos de até ~3-4min de fala).
    after(async () => {
      try {
        console.log(`[captions/generate] starting pipeline for job ${job.id}`);
        const result = await runCaptionsPipeline({ videoUrl, jobId: job.id, position });
        await prisma.generationJob.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            outputVideoUrl: result.outputVideoUrl,
            inputVideoDuration: result.durationSeconds,
            completedAt: new Date(),
            generatedPrompt: JSON.stringify({
              kind: "captions-v1",
              language: result.language,
              wordsCount: result.wordsCount,
              linesCount: result.linesCount,
              durationSeconds: result.durationSeconds,
            }),
          },
        });
        console.log(`[captions/generate] job ${job.id} COMPLETED → ${result.outputVideoUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[captions/generate] job ${job.id} FAILED:`, msg);
        await prisma.generationJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errorMessage: msg,
            completedAt: new Date(),
          },
        }).catch((updateErr) => {
          console.error("[captions/generate] failed to mark job FAILED:", updateErr);
        });
      }
    });

    return NextResponse.json({ id: job.id, status: "PROCESSING" });
  } catch (error) {
    console.error("[captions/generate] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 },
    );
  }
}
