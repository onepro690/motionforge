// Anti-repetition system for UGC generation
// Maintains rolling windows of recently used creative elements

import { prisma } from "@motion/database";

const WINDOW_SIZE = 20; // Keep last 20 of each type

type AntiRepeatField = "recentHooks" | "recentCtas" | "recentAngles" | "recentStyles";

export interface AntiRepeatContext {
  recentHooks: string[];
  recentCtas: string[];
  recentAngles: string[];
  recentStyles: string[];
}

export async function getAntiRepeatContext(userId: string): Promise<AntiRepeatContext> {
  const settings = await prisma.ugcSystemSettings.findUnique({
    where: { userId },
    select: { recentHooks: true, recentCtas: true, recentAngles: true, recentStyles: true },
  });

  return {
    recentHooks: (settings?.recentHooks as string[]) ?? [],
    recentCtas: (settings?.recentCtas as string[]) ?? [],
    recentAngles: (settings?.recentAngles as string[]) ?? [],
    recentStyles: (settings?.recentStyles as string[]) ?? [],
  };
}

export async function recordUsedElements(
  userId: string,
  elements: {
    hook?: string;
    cta?: string;
    angle?: string;
    style?: string;
  }
): Promise<void> {
  const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
  if (!settings) return;

  const updates: Partial<Record<AntiRepeatField, string[]>> = {};

  if (elements.hook) {
    updates.recentHooks = addToWindow(settings.recentHooks as string[], elements.hook);
  }
  if (elements.cta) {
    updates.recentCtas = addToWindow(settings.recentCtas as string[], elements.cta);
  }
  if (elements.angle) {
    updates.recentAngles = addToWindow(settings.recentAngles as string[], elements.angle);
  }
  if (elements.style) {
    updates.recentStyles = addToWindow(settings.recentStyles as string[], elements.style);
  }

  if (Object.keys(updates).length > 0) {
    await prisma.ugcSystemSettings.update({
      where: { userId },
      data: updates,
    });
  }
}

function addToWindow(existing: string[], newItem: string): string[] {
  const deduplicated = existing.filter((item) => item !== newItem);
  return [newItem, ...deduplicated].slice(0, WINDOW_SIZE);
}

// Record feedback patterns from reviews
export async function recordFeedbackPattern(
  userId: string,
  pattern: string,
  patternType: string,
  sentiment: "positive" | "negative"
): Promise<void> {
  const existing = await prisma.ugcFeedbackPattern.findFirst({
    where: { userId, pattern, patternType, sentiment },
  });

  if (existing) {
    await prisma.ugcFeedbackPattern.update({
      where: { id: existing.id },
      data: { frequency: { increment: 1 }, lastSeenAt: new Date() },
    });
  } else {
    await prisma.ugcFeedbackPattern.create({
      data: { userId, pattern, patternType, sentiment, frequency: 1 },
    });
  }
}

// Get top negative patterns to avoid
export async function getNegativePatterns(userId: string): Promise<string[]> {
  const patterns = await prisma.ugcFeedbackPattern.findMany({
    where: { userId, sentiment: "negative", frequency: { gte: 2 } },
    orderBy: { frequency: "desc" },
    take: 10,
    select: { pattern: true, patternType: true },
  });

  return patterns.map((p) => `${p.patternType}: ${p.pattern}`);
}
