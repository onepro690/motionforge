import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;

    const job = await prisma.generationJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (job.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Already terminal — return as-is
    if (job.status === "COMPLETED" || job.status === "FAILED") {
      return NextResponse.json({
        id: job.id,
        status: job.status,
        outputVideoUrl: job.outputVideoUrl,
        errorMessage: job.errorMessage,
      });
    }

    if (!job.externalTaskId) {
      return NextResponse.json({ id: job.id, status: job.status, outputVideoUrl: null });
    }

    // Poll kie.ai for current state
    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "KIE_API_KEY not configured" }, { status: 500 });
    }

    const kieRes = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${job.externalTaskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const kieData = (await kieRes.json()) as {
      code: number;
      data?: {
        state: string;
        resultJson?: string;
        failCode?: string;
        failMsg?: string;
      };
    };

    if (!kieRes.ok || kieData.code !== 200) {
      // Don't fail the request — just return current status
      return NextResponse.json({ id: job.id, status: job.status, outputVideoUrl: null });
    }

    const state = kieData.data?.state ?? "pending";

    // Map kie.ai states → our JobStatus
    if (state === "success") {
      const resultJson = kieData.data?.resultJson;
      let outputVideoUrl: string | null = null;

      if (resultJson) {
        try {
          const parsed = JSON.parse(resultJson) as { resultUrls?: string[] };
          outputVideoUrl = parsed.resultUrls?.[0] ?? null;
        } catch {
          // ignore parse error
        }
      }

      await prisma.generationJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          outputVideoUrl,
          completedAt: new Date(),
        },
      });

      return NextResponse.json({ id: job.id, status: "COMPLETED", outputVideoUrl });
    }

    if (state === "fail") {
      const errorMessage = `SeedDance falhou — ${kieData.data?.failMsg ?? kieData.data?.failCode ?? "erro desconhecido"}`;

      await prisma.generationJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorMessage, completedAt: new Date() },
      });

      return NextResponse.json({ id: job.id, status: "FAILED", errorMessage });
    }

    // Still running — map intermediate states
    const newStatus = state === "running" ? "RENDERING" : "PROCESSING";
    if (newStatus !== job.status) {
      await prisma.generationJob.update({
        where: { id: job.id },
        data: { status: newStatus },
      });
    }

    return NextResponse.json({ id: job.id, status: newStatus, outputVideoUrl: null });
  } catch (error) {
    console.error("[animate/[id]] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
