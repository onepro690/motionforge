import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";

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
