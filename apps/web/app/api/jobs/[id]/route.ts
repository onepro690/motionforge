import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
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

    // For Kling jobs with an externalTaskId, poll kie.ai to get current status
    if (
      job.externalTaskId &&
      job.provider === "kling" &&
      job.status !== "COMPLETED" &&
      job.status !== "FAILED"
    ) {
      const apiKey = process.env.KIE_API_KEY;
      if (apiKey) {
        try {
          const kieRes = await fetch(
            `${KIE_API_BASE}/jobs/recordInfo?taskId=${job.externalTaskId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );
          const kieData = (await kieRes.json()) as {
            code: number;
            data?: {
              state: string;
              resultJson?: string;
              failCode?: string;
              failMsg?: string;
            };
          };

          if (kieRes.ok && kieData.code === 200) {
            const state = kieData.data?.state ?? "pending";

            if (state === "success") {
              let outputVideoUrl: string | null = null;
              if (kieData.data?.resultJson) {
                try {
                  const parsed = JSON.parse(kieData.data.resultJson) as { resultUrls?: string[] };
                  outputVideoUrl = parsed.resultUrls?.[0] ?? null;
                } catch { /* ignore */ }
              }
              const updated = await prisma.generationJob.update({
                where: { id: job.id },
                data: { status: "COMPLETED", outputVideoUrl, completedAt: new Date() },
              });
              return NextResponse.json(updated);
            }

            if (state === "fail") {
              const errorMessage = `Kling falhou — ${kieData.data?.failMsg ?? kieData.data?.failCode ?? "erro desconhecido"}`;
              const updated = await prisma.generationJob.update({
                where: { id: job.id },
                data: { status: "FAILED", errorMessage, completedAt: new Date() },
              });
              return NextResponse.json(updated);
            }

            const newStatus = state === "running" ? "RENDERING" : "PROCESSING";
            if (newStatus !== job.status) {
              const updated = await prisma.generationJob.update({
                where: { id: job.id },
                data: { status: newStatus },
              });
              return NextResponse.json(updated);
            }
          }
        } catch { /* fall through and return DB state */ }
      }
    }

    return NextResponse.json(job);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch job" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
    if (["PROCESSING", "RENDERING"].includes(job.status)) {
      return NextResponse.json(
        { error: "Cannot delete a running job" },
        { status: 400 }
      );
    }

    await prisma.generationJob.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete job" },
      { status: 500 }
    );
  }
}
