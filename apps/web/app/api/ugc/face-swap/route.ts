import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";
import { startFaceSwapJob } from "@/lib/ugc/face-swap";

export const runtime = "nodejs";
export const maxDuration = 60;

const chunkSchema = z.object({
  index: z.number().int().nonnegative(),
  url: z.string().url(),
});

const createSchema = z.object({
  characterId: z.string().min(1),
  // Novo: chunks já preparados pelo cliente (usar sempre — mesmo vídeo curto vira 1 chunk).
  chunks: z.array(chunkSchema).min(1).max(500),
  // Opcional: URL do vídeo original pra referência/debug.
  sourceVideoUrl: z.string().url().optional(),
});

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await prisma.faceSwapJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      chunks: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, status: true },
      },
    },
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
      totalChunks: j.totalChunks,
      completedChunks: j.completedChunks,
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

  const sortedChunks = [...parsed.data.chunks].sort((a, b) => a.index - b.index);

  const job = await prisma.faceSwapJob.create({
    data: {
      userId: session.user.id,
      characterId: parsed.data.characterId,
      sourceVideoUrl: parsed.data.sourceVideoUrl ?? null,
      status: "QUEUED",
      totalChunks: sortedChunks.length,
      completedChunks: 0,
      chunks: {
        create: sortedChunks.map((c) => ({
          index: c.index,
          sourceUrl: c.url,
          status: "QUEUED",
        })),
      },
    },
  });

  // Submissão inicial em background — retornamos o jobId pro cliente na hora.
  // Se falhar aqui, o cron retoma os chunks em QUEUED depois.
  startFaceSwapJob(job.id).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[face-swap] startFaceSwapJob ${job.id} failed:`, msg);
    await prisma.faceSwapJob.update({
      where: { id: job.id },
      data: { status: "FAILED", errorMessage: msg.slice(0, 500) },
    });
  });

  return NextResponse.json({ jobId: job.id, totalChunks: sortedChunks.length });
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
