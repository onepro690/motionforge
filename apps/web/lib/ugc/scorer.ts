import type { ScrapedProduct, ScrapedVideo } from "./scraper";

export interface ScoringWeights {
  viewGrowthWeight: number;
  engagementGrowthWeight: number;
  creatorDiversityWeight: number;
  recurrenceWeight: number;
  accelerationWeight: number;
}

export interface ProductScore {
  score: number;
  viewGrowthRate: number;
  engagementRate: number;
  creatorCount: number;
  accelerationScore: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalComments: number;
  detectedVideoCount: number;
}

export function scoreProduct(
  product: ScrapedProduct,
  weights: ScoringWeights
): ProductScore {
  const videos = product.videos;
  if (videos.length === 0) {
    return {
      score: 0, viewGrowthRate: 0, engagementRate: 0, creatorCount: 0,
      accelerationScore: 0, totalViews: 0, totalLikes: 0, totalShares: 0,
      totalComments: 0, detectedVideoCount: 0,
    };
  }

  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const totalLikes = videos.reduce((s, v) => s + v.likes, 0);
  const totalShares = videos.reduce((s, v) => s + v.shares, 0);
  const totalComments = videos.reduce((s, v) => s + v.comments, 0);
  const uniqueCreators = new Set(videos.map((v) => v.creatorHandle)).size;

  const engagementRate = totalViews > 0
    ? (totalLikes + totalComments + totalShares) / totalViews
    : 0;

  const sorted = [...videos].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
  const third = Math.max(1, Math.floor(sorted.length / 3));
  const newestAvg = sorted.slice(0, third).reduce((s, v) => s + v.views, 0) / third;
  const oldestAvg = sorted.slice(-third).reduce((s, v) => s + v.views, 0) / third;
  const viewGrowthRate = oldestAvg > 0 ? newestAvg / oldestAvg : newestAvg > 0 ? 2 : 0;

  const now = Date.now();
  const recentCount = videos.filter((v) => now - new Date(v.publishedAt).getTime() < 86400000).length;
  const accelerationScore = Math.min(recentCount / Math.max(videos.length, 1) * 3, 1);
  const recurrenceScore = Math.min(videos.length / 5, 1);
  const creatorDiversityScore = Math.min(uniqueCreators / 5, 1);
  const normalizedGrowth = Math.min(viewGrowthRate / 3, 1);
  const normalizedEngagement = Math.min(engagementRate / 0.10, 1);

  const score = Math.round(
    (
      normalizedGrowth * weights.viewGrowthWeight +
      normalizedEngagement * weights.engagementGrowthWeight +
      creatorDiversityScore * weights.creatorDiversityWeight +
      recurrenceScore * weights.recurrenceWeight +
      accelerationScore * weights.accelerationWeight
    ) * 100
  );

  return {
    score,
    viewGrowthRate,
    engagementRate,
    creatorCount: uniqueCreators,
    accelerationScore,
    totalViews,
    totalLikes,
    totalShares,
    totalComments,
    detectedVideoCount: videos.length,
  };
}

// Detect dominant creative patterns from videos
export function analyzeCreativePatterns(videos: ScrapedVideo[]) {
  const hookPatterns = detectHookPatterns(videos);
  const styles = detectUgcStyles(videos);

  return { hookPatterns, styles };
}

function detectHookPatterns(videos: ScrapedVideo[]): string[] {
  const patterns: Record<string, number> = {};
  const hookSignals = [
    { key: "descoberta", terms: ["achei", "encontrei", "descobri", "olha isso", "olha que"] },
    { key: "choque", terms: ["impossível", "não acredito", "meu deus", "absurdo"] },
    { key: "transformação", terms: ["mudou", "transformou", "nunca mais", "minha vida", "diferença"] },
    { key: "problema-solução", terms: ["problema", "resolvi", "solução", "não conseguia", "agora consigo"] },
    { key: "recomendação", terms: ["recomendo", "precisam", "vocês precisam", "todo mundo deveria"] },
    { key: "comparativo", terms: ["antes e depois", "comparando", "vs ", "melhor que"] },
    { key: "curiosidade", terms: ["vocês sabem", "sabia que", "você sabia", "alguém me disse"] },
  ];

  for (const video of videos) {
    const desc = video.description.toLowerCase();
    for (const { key, terms } of hookSignals) {
      if (terms.some((t) => desc.includes(t))) {
        patterns[key] = (patterns[key] ?? 0) + 1;
      }
    }
  }

  return Object.entries(patterns)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([key]) => key);
}

function detectUgcStyles(videos: ScrapedVideo[]): string[] {
  const styles: Record<string, number> = {};

  for (const video of videos) {
    const desc = video.description.toLowerCase();
    if (desc.includes("review") || desc.includes("testei") || desc.includes("usando")) {
      styles["review"] = (styles["review"] ?? 0) + 1;
    }
    if (desc.includes("achei") || desc.includes("encontrei") || desc.includes("descobri")) {
      styles["descoberta"] = (styles["descoberta"] ?? 0) + 1;
    }
    if (desc.includes("unboxing") || desc.includes("chegou") || desc.includes("recebi")) {
      styles["unboxing"] = (styles["unboxing"] ?? 0) + 1;
    }
    if (desc.includes("antes") && desc.includes("depois")) {
      styles["transformação"] = (styles["transformação"] ?? 0) + 1;
    }
  }

  return Object.entries(styles)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([key]) => key);
}
