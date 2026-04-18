// TikTok Shop trend scraper — video-based, groups by product
// Real TikTok URLs constructed from video_id + author.unique_id

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

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

// LLM-based product identification — replaces the regex/hashtag-join approach
// that returned garbage like "luansantana viralizarnotiktok" (singer name + generic tag).
// GPT-4o-mini reads descriptions semantically and returns a clean product name
// per video, grouping synonyms together (e.g. "massageador facial" + "massageador
// pra rosto" → same product).
async function identifyProductsLLM(
  videos: ScrapedVideo[]
): Promise<Map<string, { name: string; category: string | null } | null>> {
  const result = new Map<string, { name: string; category: string | null } | null>();
  if (!process.env.OPENAI_API_KEY) return result;

  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const BATCH = 40;

  for (let i = 0; i < videos.length; i += BATCH) {
    const batch = videos.slice(i, i + BATCH);
    const items = batch.map((v, idx) => ({
      idx,
      description: v.description.replace(/\s+/g, " ").trim().slice(0, 400),
    }));

    const prompt = `Você é especialista em TikTok Shop Brasil. Para cada vídeo, extraia o NOME REAL DO PRODUTO sendo vendido baseado na descrição.

REGRAS:
- Nome do produto deve ser curto (2-5 palavras), em português do Brasil.
- SEM hashtags, SEM emojis, SEM nomes de creators/cantores/celebridades, SEM nomes de marcas de rede social.
- AGRUPE sinônimos: "massageador facial", "massageador pra rosto", "aparelho massagem rosto" → todos devem virar "Massageador Facial".
- Nomes genéricos devem ficar no singular e capitalizados: "Batom Líquido Matte", "Organizador Geladeira", "Luminária Lua LED".
- Se a descrição é só trend/meme/dancinha sem produto identificável, retorne productName=null.
- category é uma de: "Beleza", "Casa", "Moda", "Tecnologia", "Fitness", "Pet", "Cozinha", "Decoração", "Infantil", "Outros".

VÍDEOS (JSON):
${JSON.stringify(items, null, 2)}

Responda APENAS JSON válido no formato:
{"products": [{"idx": 0, "productName": "Nome do Produto", "category": "Beleza"}, {"idx": 1, "productName": null, "category": null}, ...]}`;

    try {
      const { text } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
        temperature: 0.2,
      });
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]) as {
        products?: Array<{ idx: number; productName: string | null; category: string | null }>;
      };
      for (const p of parsed.products ?? []) {
        const video = batch[p.idx];
        if (!video) continue;
        if (!p.productName || p.productName.trim().length < 3) {
          result.set(video.videoId, null);
        } else {
          result.set(video.videoId, {
            name: p.productName.trim().slice(0, 60),
            category: p.category ?? null,
          });
        }
      }
    } catch (err) {
      console.error("[scraper] LLM product ID error:", err);
    }
  }

  return result;
}

// Normaliza o nome para agrupar variações superficiais de capitalização/espaço.
function normalizeProductKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function groupVideosByProduct(videos: ScrapedVideo[]): Promise<ScrapedProduct[]> {
  const llmMap = await identifyProductsLLM(videos);
  const productMap = new Map<string, ScrapedProduct>();

  for (const video of videos) {
    const llmResult = llmMap.get(video.videoId);
    // LLM explicitamente disse "sem produto" → descarta o vídeo.
    if (llmMap.has(video.videoId) && llmResult === null) continue;

    const identified = llmResult ?? identifyProductFallback(video);
    if (!identified) continue;

    const key = normalizeProductKey(identified.name);
    if (!key) continue;

    if (!productMap.has(key)) {
      productMap.set(key, {
        name: identified.name,
        category: identified.category ?? undefined,
        thumbnailUrl: video.thumbnailUrl,
        productUrl: `https://www.tiktok.com/search?q=${encodeURIComponent(identified.name)}`,
        videos: [],
      });
    }

    const product = productMap.get(key)!;
    product.videos.push(video);

    // Keep thumbnail from video with most views
    const bestVideo = product.videos.reduce((best, v) => v.views > best.views ? v : best, product.videos[0]);
    product.thumbnailUrl = bestVideo.thumbnailUrl;
  }

  for (const p of productMap.values()) {
    p.videos.sort((a, b) => b.views - a.views);
  }

  return Array.from(productMap.values()).filter((p) => p.videos.length >= 1);
}

// Fallback usado só quando OPENAI_API_KEY não está configurada.
// Tenta os patterns de descrição; se falhar tudo, descarta o vídeo
// (melhor nenhum produto do que "hashtag1 hashtag2" virando nome).
function identifyProductFallback(video: ScrapedVideo): { name: string; category: string | null } | null {
  const desc = video.description;

  const patterns = [
    /produto:\s*([^#\n]+)/i,
    /item:\s*([^#\n]+)/i,
    /testando\s+([^#\n,]{5,})/i,
    /usando\s+([^#\n,]{5,})/i,
    /review\s+([^#\n,]{5,})/i,
    /comprei\s+([^#\n,]{5,})/i,
  ];

  for (const pattern of patterns) {
    const match = desc.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim().replace(/[#@].*$/, "").trim().slice(0, 60);
      if (name.length >= 4) return { name, category: null };
    }
  }

  return null;
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

    const products = await groupVideosByProduct(allVideos);

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
