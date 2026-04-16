import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { DEFAULT_PROMPT_TEMPLATES } from "@/lib/ugc/defaults";
import { z } from "zod";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  content: z.string().min(10).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const tmpl = await prisma.ugcPromptTemplate.findUnique({ where: { id } });
  if (!tmpl || tmpl.userId !== session.user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const updated = await prisma.ugcPromptTemplate.update({
    where: { id },
    data: { ...parsed.data, version: { increment: 1 }, isDefault: false },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const tmpl = await prisma.ugcPromptTemplate.findUnique({ where: { id } });
  if (!tmpl || tmpl.userId !== session.user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.ugcPromptTemplate.delete({ where: { id } });
  return NextResponse.json({ success: true });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Reset to default
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const tmpl = await prisma.ugcPromptTemplate.findUnique({ where: { id } });
  if (!tmpl || tmpl.userId !== session.user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const defaultContent = DEFAULT_PROMPT_TEMPLATES[tmpl.stage]?.content;
  if (!defaultContent) return NextResponse.json({ error: "No default for this stage" }, { status: 400 });

  const updated = await prisma.ugcPromptTemplate.update({
    where: { id },
    data: { content: defaultContent, isDefault: true },
  });

  return NextResponse.json(updated);
}
