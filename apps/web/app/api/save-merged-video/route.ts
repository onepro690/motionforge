import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const inputImageUrl = formData.get("inputImageUrl") as string | null;
    const takeCount = formData.get("takeCount") as string | null;
    // JSON array of individual take video URLs (in merge order) — stored for re-joining later
    const takeVideoUrlsJson = formData.get("takeVideoUrls") as string | null;

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const blob = await put(
      `merged-${session.user.id}-${Date.now()}.mp4`,
      file,
      { access: "public", contentType: "video/mp4", addRandomSuffix: false }
    );

    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "COMPLETED",
        provider: "merged",
        inputImageUrl: inputImageUrl ?? "",
        promptText: `Vídeo juntado (${takeCount ?? "?"} takes)`,
        // Store take URLs in generatedPrompt so history can offer re-join
        generatedPrompt: takeVideoUrlsJson ?? undefined,
        outputVideoUrl: blob.url,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    return NextResponse.json({ id: job.id, url: blob.url });
  } catch (error) {
    console.error("[save-merged-video] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro interno" }, { status: 500 });
  }
}
