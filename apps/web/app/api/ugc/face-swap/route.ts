import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";
import { startFaceSwap } from "@/lib/ugc/face-swap";

export const runtime = "nodejs";

const createSchema = z.object({
  sourceVideoUrl: z.string().url(),
  characterId: z.string().min(1),
});

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await prisma.faceSwapJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const characterIds = Array.from(new Set(jobs.map((j) => j.characterId)));
  const characters = await prisma.ugcCharacter.findMany({
    where: { id: { in: characterIds } },
    select: { id: true, name: true, imageUrl: true },
  });
  const charMap = new Map(characters.map((c) => [c.id, c]));

  return NextResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      sourceVideoUrl: j.sourceVideoUrl,
      resultVideoUrl: j.resultVideoUrl,
      errorMessage: j.errorMessage,
      character: charMap.get(j.characterId) ?? null,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", details: parsed.error.message },
      { status: 400 },
    );
  }

  const character = await prisma.ugcCharacter.findUnique({
    where: { id: parsed.data.characterId },
  });
  if (!character || character.userId !== session.user.id) {
    return NextResponse.json({ error: "Personagem não encontrado" }, { status: 404 });
  }

  const job = await prisma.faceSwapJob.create({
    data: {
      userId: session.user.id,
      characterId: parsed.data.characterId,
      sourceVideoUrl: parsed.data.sourceVideoUrl,
      status: "QUEUED",
    },
  });

  try {
    await startFaceSwap(job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.faceSwapJob.update({
      where: { id: job.id },
      data: { status: "FAILED", errorMessage: msg },
    });
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ jobId: job.id });
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id é obrigatório" }, { status: 400 });

  const job = await prisma.faceSwapJob.findUnique({ where: { id } });
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: "Job não encontrado" }, { status: 404 });
  }

  await prisma.faceSwapJob.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
