// TikTok Shop trend scraper — video-based, groups by product
// Real TikTok URLs constructed from video_id + author.unique_id

export interface ScrapedProduct {
  name: string;
  productId?: string;
  category?: string;
  thumbnailUrl?: string;
  price?: number;
  priceFormatted?: string;
  soldCount?: number;
  rating?: number;
  reviewCount?: number;
  shopName?: string;
  productUrl?: string;
  videos: ScrapedVideo[];
}

export interface ScrapedVideo {
  videoId: string;       // numeric ID for TikTok URL
  creatorHandle: string; // author.unique_id
  videoUrl: string;      // real TikTok page URL: tiktok.com/@handle/video/id
  thumbnailUrl: string;  // cover image (shows the product)
  description: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  publishedAt: string;
  productMentions: string[];
}

export interface ScrapeResult {
  products: ScrapedProduct[];
  rawVideoCount: number;
  scrapedAt: string;
}

// ── Video search ────────────────────────────────────────────────────────────

async function searchTikTokVideos(keyword: string, apiKey: string): Promise<ScrapedVideo[]> {
  const url = `https://tiktok-scraper7.p.rapidapi.com/feed/search?keywords=${encodeURIComponent(keyword)}&region=br&count=20&cursor=0&publish_time=7&sort_type=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com",
        "x-rapidapi-key": apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error(`[scraper] fetch error "${keyword}":`, err);
    return [];
  }

  if (!res.ok) {
    console.error(`[scraper] HTTP ${res.status} for "${keyword}"`);
    return [];
  }

  const data = await res.json() as {
    code?: number;
    data?: {
      videos?: Array<{
        video_id?: string;
        aweme_id?: string;
        title?: string;
        desc?: string;
        cover?: string;
        origin_cover?: string;
        play?: string;
        play_count?: number;
        digg_count?: number;
        comment_count?: number;
        share_count?: number;
        create_time?: number;
        author?: { unique_id?: string; nickname?: string };
      }>;
    };
  };

  if (data.code !== 0 && data.code !== undefined) return [];

  return (data?.data?.videos ?? []).map((v) => {
    const authorHandle = v.author?.unique_id ?? v.author?.nickname ?? "unknown";
    // video_id is the numeric ID used in TikTok URLs; aweme_id is a hash
    const numericId = v.video_id ?? v.aweme_id ?? `${Date.now()}`;
    const tiktokUrl = `https://www.tiktok.com/@${authorHandle}/video/${numericId}`;
    const description = v.title ?? v.desc ?? "";

    return {
      videoId: numericId,
      creatorHandle: authorHandle,
      videoUrl: tiktokUrl,
      thumbnailUrl: v.cover ?? v.origin_cover ?? "",
      description,
      views: v.play_count ?? 0,
      likes: v.digg_count ?? 0,
      comments: v.comment_count ?? 0,
      shares: v.share_count ?? 0,
      publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : new Date().toISOString(),
      productMentions: extractProductMentions(description),
    } satisfies ScrapedVideo;
  });
}

function extractProductMentions(description: string): string[] {
  const mentions: string[] = [];
  const shopPattern = /#[\w]+shop/gi;
  const shopMatches = description.match(shopPattern) ?? [];
  mentions.push(...shopMatches.map((m) => m.replace("#", "")));
  return [...new Set(mentions)];
}

// ── Group videos into products ──────────────────────────────────────────────

function groupVideosByProduct(videos: ScrapedVideo[]): ScrapedProduct[] {
  const productMap = new Map<string, ScrapedProduct>();

  for (const video of videos) {
    const key = identifyProduct(video);

    if (!productMap.has(key)) {
      productMap.set(key, {
        name: key,
        // Use the thumbnail of the highest-view video as product photo
        thumbnailUrl: video.thumbnailUrl,
        // TikTok search URL for the product name
        productUrl: `https://www.tiktok.com/search?q=${encodeURIComponent(key)}`,
        videos: [],
      });
    }

    const product = productMap.get(key)!;
    product.videos.push(video);

    // Keep the thumbnail from the video with most views
    const bestVideo = product.videos.reduce((best, v) => v.views > best.views ? v : best, product.videos[0]);
    product.thumbnailUrl = bestVideo.thumbnailUrl;
  }

  // Sort videos within each product by views (highest first)
  for (const p of productMap.values()) {
    p.videos.sort((a, b) => b.views - a.views);
  }

  return Array.from(productMap.values()).filter((p) => p.videos.length >= 1);
}

function identifyProduct(video: ScrapedVideo): string {
  const desc = video.description.toLowerCase();

  const patterns = [
    /produto:\s*([^#\n]+)/i,
    /item:\s*([^#\n]+)/i,
    /testando\s+([^#\n,]{5,})/i,
    /usando\s+([^#\n,]{5,})/i,
    /review\s+([^#\n,]{5,})/i,
    /achei\s+([^#\n,]{5,})/i,
    /comprei\s+([^#\n,]{5,})/i,
  ];

  for (const pattern of patterns) {
    const match = desc.match(pattern);
    if (match?.[1]) return match[1].trim().slice(0, 60);
  }

  // Use non-generic hashtags as product name
  const hashtags = desc.match(/#(\w+)/g) ?? [];
  const skip = new Set(["tiktok", "tiktokshop", "tiktokshopbrasil", "tiktokshopbr", "viral",
    "fyp", "foryou", "shop", "review", "trending", "brasil", "br", "ad", "shorts",
    "reels", "maquiagem", "beleza", "makeup", "beauty", "skincare", "fashion", "moda"]);
  const productHashtags = hashtags
    .map((h) => h.slice(1))
    .filter((h) => h.length > 3 && !skip.has(h.toLowerCase()))
    .slice(0, 2);

  if (productHashtags.length > 0) return productHashtags.join(" ").slice(0, 60);

  // Fallback: first meaningful chunk of description
  return video.description.slice(0, 50).replace(/[#\n]/g, " ").trim() || "Produto TikTok Shop";
}

// ── Mock data ───────────────────────────────────────────────────────────────

function generateMockData(keywords: string[]): ScrapeResult {
  const mockProducts: ScrapedProduct[] = [
    {
      name: "Massageador Facial Elétrico",
      category: "Beleza",
      thumbnailUrl: "https://picsum.photos/seed/prod1/400/500",
      productUrl: "https://www.tiktok.com/search?q=massageador+facial",
      videos: Array.from({ length: 6 }, (_, i) => ({
        videoId: `7500000000000000${i}`,
        creatorHandle: `creator_beauty_${i + 1}`,
        videoUrl: `https://www.tiktok.com/@creator_beauty_${i + 1}/video/7500000000000000${i}`,
        thumbnailUrl: `https://picsum.photos/seed/vid1${i}/300/500`,
        description: `Amei esse massageador facial! Link no bio #tiktokshopbrasil #beleza #skincare`,
        views: Math.floor(Math.random() * 500000 + 50000),
        likes: Math.floor(Math.random() * 30000 + 2000),
        comments: Math.floor(Math.random() * 2000 + 100),
        shares: Math.floor(Math.random() * 5000 + 200),
        publishedAt: new Date(Date.now() - Math.random() * 3 * 86400000).toISOString(),
        productMentions: ["tiktokshopbrasil"],
      })),
    },
    {
      name: "Organizador Magnético Geladeira",
      category: "Casa",
      thumbnailUrl: "https://picsum.photos/seed/prod2/400/500",
      productUrl: "https://www.tiktok.com/search?q=organizador+magnetico+geladeira",
      videos: Array.from({ length: 5 }, (_, i) => ({
        videoId: `7600000000000000${i}`,
        creatorHandle: `creator_casa_${i + 1}`,
        videoUrl: `https://www.tiktok.com/@creator_casa_${i + 1}/video/7600000000000000${i}`,
        thumbnailUrl: `https://picsum.photos/seed/vid2${i}/300/500`,
        description: `ISSO MUDOU MINHA COZINHA! Organizador magnético #tiktokshopbrasil #organizacao #casa`,
        views: Math.floor(Math.random() * 300000 + 80000),
        likes: Math.floor(Math.random() * 20000 + 3000),
        comments: Math.floor(Math.random() * 1500 + 200),
        shares: Math.floor(Math.random() * 4000 + 300),
        publishedAt: new Date(Date.now() - Math.random() * 2 * 86400000).toISOString(),
        productMentions: ["tiktokshopbrasil"],
      })),
    },
    {
      name: "LED Luz Lunar para Quarto",
      category: "Decoração",
      thumbnailUrl: "https://picsum.photos/seed/prod3/400/500",
      productUrl: "https://www.tiktok.com/search?q=luz+lunar+led+quarto",
      videos: Array.from({ length: 8 }, (_, i) => ({
        videoId: `7700000000000000${i}`,
        creatorHandle: `creator_deco_${i + 1}`,
        videoUrl: `https://www.tiktok.com/@creator_deco_${i + 1}/video/7700000000000000${i}`,
        thumbnailUrl: `https://picsum.photos/seed/vid3${i}/300/500`,
        description: `Meu quarto ficou incrível! #tiktokshopbrasil #decoracao #quarto #led`,
        views: Math.floor(Math.random() * 800000 + 100000),
        likes: Math.floor(Math.random() * 60000 + 5000),
        comments: Math.floor(Math.random() * 4000 + 500),
        shares: Math.floor(Math.random() * 10000 + 1000),
        publishedAt: new Date(Date.now() - Math.random() * 2 * 86400000).toISOString(),
        productMentions: ["tiktokshopbrasil"],
      })),
    },
  ];

  return {
    products: mockProducts,
    rawVideoCount: mockProducts.reduce((s, p) => s + p.videos.length, 0),
    scrapedAt: new Date().toISOString(),
  };
}

// ── Keywords ────────────────────────────────────────────────────────────────

export const TIKTOK_SEARCH_KEYWORDS = [
  "tiktok shop brasil",
  "tiktokshopbrasil",
  "achado tiktok shop",
  "comprei tiktok shop",
  "produto viral tiktok",
  "você precisa ter isso",
  "compra que valeu",
  "testei tiktok shop",
];

// ── Main export ─────────────────────────────────────────────────────────────

export async function scrapeTrendingProducts(
  keywords: string[],
  apiKey?: string
): Promise<ScrapeResult> {
  if (!apiKey) {
    console.log("[scraper] No API key — mock data");
    return generateMockData(keywords);
  }

  try {
    const allVideos: ScrapedVideo[] = [];
    const seenIds = new Set<string>();

    for (const keyword of keywords.slice(0, 5)) {
      const videos = await searchTikTokVideos(keyword, apiKey);
      console.log(`[scraper] "${keyword}" → ${videos.length} videos`);
      for (const v of videos) {
        if (!seenIds.has(v.videoId)) {
          seenIds.add(v.videoId);
          allVideos.push(v);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (allVideos.length === 0) {
      console.warn("[scraper] No videos found, falling back to mock");
      return generateMockData(keywords);
    }

    const products = groupVideosByProduct(allVideos);

    // Sort by total views (most viral first)
    products.sort((a, b) => {
      const aViews = a.videos.reduce((s, v) => s + v.views, 0);
      const bViews = b.videos.reduce((s, v) => s + v.views, 0);
      return bViews - aViews;
    });

    return {
      products,
      rawVideoCount: allVideos.length,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[scraper] Error, mock fallback:", err);
    return generateMockData(keywords);
  }
}
