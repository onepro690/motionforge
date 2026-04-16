import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { DEFAULT_SCORING_WEIGHTS } from "@/lib/ugc/defaults";
import { z } from "zod";

const settingsSchema = z.object({
  dailyVideoLimit: z.number().int().min(1).max(50).optional(),
  minDurationSeconds: z.number().int().min(5).max(60).optional(),
  maxDurationSeconds: z.number().int().min(10).max(120).optional(),
  minTakesPerVideo: z.number().int().min(1).max(6).optional(),
  maxTakesPerVideo: z.number().int().min(1).max(6).optional(),
  autoMode: z.boolean().optional(),
  requireProductApproval: z.boolean().optional(),
  requireVideoApproval: z.boolean().optional(),
  defaultVoice: z.string().optional(),
  defaultModel: z.enum(["veo3-fast", "veo3-quality"]).optional(),
  enableCaptions: z.boolean().optional(),
  tiktokScraperApiKey: z.string().optional(),
  searchKeywords: z.string().optional(),
  scoringWeights: z.object({
    viewGrowthWeight: z.number().min(0).max(1),
    engagementGrowthWeight: z.number().min(0).max(1),
    creatorDiversityWeight: z.number().min(0).max(1),
    recurrenceWeight: z.number().min(0).max(1),
    accelerationWeight: z.number().min(0).max(1),
  }).optional(),
});

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const settings = await prisma.ugcSystemSettings.upsert({
    where: { userId },
    create: {
      userId,
      scoringWeights: DEFAULT_SCORING_WEIGHTS,
      updatedAt: new Date(),
    },
    update: {},
  });

  return NextResponse.json(settings);
}

export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input", details: parsed.error.errors }, { status: 400 });

  const updated = await prisma.ugcSystemSettings.upsert({
    where: { userId },
    create: {
      userId,
      ...parsed.data,
      updatedAt: new Date(),
    },
    update: {
      ...parsed.data,
    },
  });

  return NextResponse.json(updated);
}
