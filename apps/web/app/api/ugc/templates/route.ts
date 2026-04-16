import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { DEFAULT_PROMPT_TEMPLATES } from "@/lib/ugc/defaults";
import { z } from "zod";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  // Ensure defaults exist
  for (const [stage, tmpl] of Object.entries(DEFAULT_PROMPT_TEMPLATES)) {
    const exists = await prisma.ugcPromptTemplate.findFirst({ where: { userId, stage } });
    if (!exists) {
      await prisma.ugcPromptTemplate.create({
        data: { userId, stage, name: tmpl.name, content: tmpl.content, isDefault: true, isActive: true },
      });
    }
  }

  const templates = await prisma.ugcPromptTemplate.findMany({
    where: { userId },
    orderBy: { stage: "asc" },
  });

  return NextResponse.json(templates);
}

const createSchema = z.object({
  stage: z.string(),
  name: z.string().min(1),
  content: z.string().min(10),
});

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const template = await prisma.ugcPromptTemplate.create({
    data: { userId: session.user.id, ...parsed.data, isDefault: false },
  });

  return NextResponse.json(template);
}
