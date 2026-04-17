import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { pollAndAssembleTakes } from "@/lib/ugc/pipeline";

export const maxDuration = 300;
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") ?? "1");
  const limit = parseInt(searchParams.get("limit") ?? "12");
  const skip = (page - 1) * limit;

  const where = {
    userId,
    ...(status ? { status: status as "AWAITING_REVIEW" | "APPROVED" | "FAILED" } : {}),
  };

  const [videos, total] = await Promise.all([
    prisma.ugcGeneratedVideo.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip,
      include: {
        product: { select: { name: true, thumbnailUrl: true, score: true } },
        _count: { select: { takes: true } },
        takes: {
          select: { takeIndex: true, status: true, durationSeconds: true, errorMessage: true, retryCount: true },
          orderBy: { takeIndex: "asc" },
        },
      },
    }),
    prisma.ugcGeneratedVideo.count({ where }),
  ]);

  // Dispara poll em background pra qualquer vídeo em GENERATING_TAKES — sem
  // depender do cron. `after()` segura a execução no runtime da Vercel depois
  // que a response vai embora, então o pipeline avança mesmo que o usuário
  // só esteja na listagem.
  const inFlight = videos
    .filter((v) => v.status === "GENERATING_TAKES" || v.status === "ASSEMBLING")
    .map((v) => v.id);
  if (inFlight.length > 0) {
    after(async () => {
      for (const id of inFlight) {
        try {
          await pollAndAssembleTakes(id);
        } catch (err) {
          console.error(`[generations/list] poll failed for ${id}:`, err);
        }
      }
    });
  }

  return NextResponse.json({ videos, total, page, limit, pages: Math.ceil(total / limit) });
}
