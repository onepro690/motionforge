import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { z } from "zod";

const schema = z.object({ name: z.string().min(2) });

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data: { name: parsed.data.name },
  });

  return NextResponse.json(user);
}
