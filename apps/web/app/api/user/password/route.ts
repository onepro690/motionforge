import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { z } from "zod";

const schema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, providerId: "credential" },
  });

  if (!account?.password) {
    return NextResponse.json(
      { error: "No password set for this account" },
      { status: 400 }
    );
  }

  const valid = await bcrypt.compare(
    parsed.data.currentPassword,
    account.password
  );
  if (!valid) {
    return NextResponse.json(
      { error: "Senha atual incorreta" },
      { status: 400 }
    );
  }

  const hash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.account.update({
    where: { id: account.id },
    data: { password: hash },
  });

  return NextResponse.json({ success: true });
}
