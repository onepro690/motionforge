import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { z } from "zod";

// GET — lista personagens do usuário
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const characters = await prisma.ugcCharacter.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ characters });
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  imageUrl: z.string().url(),
});

// POST — cria novo personagem
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dados inválidos", details: parsed.error.message }, { status: 400 });
  }

  const character = await prisma.ugcCharacter.create({
    data: {
      userId: session.user.id,
      name: parsed.data.name,
      imageUrl: parsed.data.imageUrl,
    },
  });

  return NextResponse.json({ character });
}

// DELETE — deleta personagem por id (via query param)
export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id é obrigatório" }, { status: 400 });

  const character = await prisma.ugcCharacter.findUnique({ where: { id } });
  if (!character || character.userId !== session.user.id) {
    return NextResponse.json({ error: "Personagem não encontrado" }, { status: 404 });
  }

  await prisma.ugcCharacter.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
