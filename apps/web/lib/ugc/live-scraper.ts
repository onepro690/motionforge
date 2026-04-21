// TikTok Shop Live Scraper — bulk discovery approach
//
// NOVO FLUXO (sem dependência de api-live per-handle, que é WAF-limited):
//   1. Rotaciona 30 calls para /live lobby com device_id/UA frescos —
//      cada call retorna recomendações personalizadas diferentes.
//   2. Parse __UNIVERSAL_DATA__ extraindo TODOS os objetos room com
//      roomId + owner.uniqueId + hasCommerce + status já embutidos.
//   3. Para cada roomId, chama webcast/room/info (endpoint autoritativo
//      que dá status, has_commerce_goods, HLS URL em UMA call — e NÃO
//      é WAF-bloqueado como api-live).
//   4. Fallback: para seed/manual creators que não apareceram no lobby,
//      chama api-live com rate limit pesado (30 handles max, 500ms gap).
//   5. Filtro final: status=2 AND has_commerce_goods=true.

import { TikTokWebClient } from "tiktok-live-connector";
import { prisma } from "@motion/database";

export interface LiveProduct {
  name: string;
  thumbnailUrl?: string;
  priceFormatted?: string;
}

export interface ScrapedLive {
  roomId: string;
  title: string;
  hostHandle: string;
  hostNickname: string;
  hostAvatarUrl: string;

  viewerCount: number;
  totalViewers: number;
  likeCount: number;

  estimatedOrders: number;
  productCount: number;
  products: LiveProduct[];

  isLive: boolean;
  startedAt?: string;

  hlsUrl?: string;
  flvUrl?: string;
  liveUrl: string;
  thumbnailUrl: string;

  salesScore: number;
}

export interface LiveScrapeResult {
  lives: ScrapedLive[];
  totalFound: number;
  scrapedAt: string;
  debug?: {
    keywordsSearched: string[];
    candidatesFound: number;
    verifiedLive: number;
    checkErrors: number;
    liveWithCommerce: number;
    liveWithoutCommerce: number;
    usedMock: boolean;
    lobbyRoomsFound?: number;
    lobbyRoomsWithId?: number;
    fallbackChecked?: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcSalesScore(v: { viewerCount: number; likeCount: number; isLive: boolean }): number {
  return Math.round(
    Math.min(v.viewerCount / 500_000, 1) * 50 +
    Math.min(v.likeCount / 100_000, 1) * 30 +
    (v.isLive ? 20 : 0)
  );
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDeviceId(): string {
  // TikTok web device_ids são 19 dígitos iniciando em 7...
  const base = 7_000_000_000_000_000_000;
  const rand = Math.floor(Math.random() * 999_999_999_999_999_999);
  return (base + rand).toString();
}

// Pool seed massivamente expandido: inclui top affiliates BR conhecidos do
// TikTok Shop (beleza, moda, tech, casa, fitness). Cresce ao longo de runs
// conforme creators detectados viram parte do pool LRU.
const SEED_SHOP_CREATORS = [
  // Mega influencers BR
  "liseleooliveira", "virginia", "gkay", "bocarosa", "rafakalimann",
  "juliette", "camilaloures", "luanasantana", "mileidemihaile", "gessicakayane",
  "lorrana", "any.awuada", "rafaelrochatv", "belochatto", "tatisantos",
  "carolbuffara", "ju_ferraz", "biancaandrade", "mariamaud", "naiaraazevedo",
  // Beleza & maquiagem
  "boca_rosa", "mariliamendonca", "blogueirinhaoficial", "pabllovittar",
  "lexarocha", "gisele.bundchen", "mariahcarey", "lariferreira",
  "babidiamond", "karolconka", "tatawerneck", "deolane_bezerra",
  "nataliabarulio", "leticiapolyak", "alicehirose", "mirelabianchi",
  // Moda
  "camilacoelho", "thassianaves", "nahfloresta", "jessicavelozo",
  "evelinreginatto", "monicamarcondes", "juliana_passos", "marysearch",
  "biancacolepicolo", "marinaruybarbosa", "paolaoliveira", "raitornado",
  // Casa, cozinha, achados
  "bettinarudolph", "blogueirinhadecor", "casadasmaes", "cozinhabr",
  "ricaparadatal", "achadinhosbr", "achadostiktok", "achadinhosmagalu",
  "achadosmami", "lojaibyte", "solucoespraticas", "dicasdemaepratica",
  // Tech / eletrônicos
  "moacycoelho", "celularreviews", "techreviewbr", "gadgetsbrasil",
  "eletronicoscombr", "celulardica", "techzinhooficial",
  // Moda masculina
  "carlinhosmaia", "mcdaniel", "malvimoises", "eduguedes",
  "fabioporchat", "caiocastro", "rodrigosantoro",
  // Fitness / suplementos
  "gabrielamarques", "juliaperezfit", "juliamello", "felipefranco",
  "saudebrasilfit", "fitnessdia", "suplementotop",
  // Pet
  "petlovesbr", "cachorrinhostiktok", "mundopet",
  // Cabelo
  "marcospaulo.cabelos", "cabelocombr", "oneverhair",
  // Lojistas TikTok Shop BR conhecidos
  "shoptiktokbr", "lojavirtualbr", "ofertabrasil", "achadoseconomias",
];

// ── RapidAPI run-state ──────────────────────────────────────────────────────
// Setado no início de scrapeLiveSessions. checkLiveStatus usa pra bypassar
// WAF via proxy residencial. tikwm.com calls ficam diretos (tikwm não é blocked).

let _runApiKey: string | undefined;
let _runApiHost = "tiktok-scraper7.p.rapidapi.com";

function providerFromHost(host: string): "scraper7" | "api23" | "other" {
  if (host.includes("scraper7") || host.includes("tikwm")) return "scraper7";
  if (host.includes("api23")) return "api23";
  return "other";
}

// ── Tikwm user info (pra manual add + verificação alt) ──────────────────────

export interface TikwmUserInfo {
  handle: string;
  nickname: string;
  avatarUrl: string;
  bio?: string;
  verified?: boolean;
}

export async function fetchTikwmUserInfo(handle: string): Promise<TikwmUserInfo | null> {
  // tikwm.com NÃO é bloqueado pelo WAF — chamada direta é mais rápida
  const url = `https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(handle)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": randomUA() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: number;
      data?: {
        user?: {
          uniqueId?: string;
          unique_id?: string;
          nickname?: string;
          avatarThumb?: string;
          avatar_thumb?: string;
          avatarMedium?: string;
          avatar_medium?: string;
          signature?: string;
          verified?: boolean;
        };
      };
    };
    if (data.code !== 0 || !data.data?.user) return null;
    const u = data.data.user;
    const uniqueId = u.uniqueId ?? u.unique_id ?? handle;
    const avatar =
      u.avatarMedium ?? u.avatar_medium ?? u.avatarThumb ?? u.avatar_thumb ?? "";
    return {
      handle: uniqueId,
      nickname: u.nickname ?? uniqueId,
      avatarUrl: avatar,
      bio: u.signature,
      verified: u.verified,
    };
  } catch {
    return null;
  }
}

// Exported: verificação pública usada pela rota de creators (add manual).
// Retorna dados completos se live com commerce, senão null.
export async function checkCreatorLiveNow(handle: string): Promise<{
  roomId: string;
  title?: string;
  hlsUrl?: string;
  flvUrl?: string;
  coverUrl?: string;
  userCount?: number;
  likeCount?: number;
  startedAt?: number;
  hasCommerce: boolean;
} | null> {
  const check = await checkLiveStatus(handle);
  if (!check.isLive || !check.roomId) return null;
  const info = await fetchFullRoomInfo(check.roomId);
  if (!info || info.status !== 2) return null;
  return {
    roomId: check.roomId,
    title: info.title ?? check.title,
    hlsUrl: info.hlsUrl,
    flvUrl: info.flvUrl,
    coverUrl: info.coverUrl ?? check.coverUrl,
    userCount: info.userCount ?? check.userCount,
    likeCount: info.likeCount ?? check.enterCount,
    startedAt: info.startedAt ?? check.startedAt,
    hasCommerce: info.hasCommerce,
  };
}

// ── Tikwm feed search (principal) ────────────────────────────────────────────
// Busca vídeos recentes sobre live shop BR, extrai authors.
// Pool: ~80 queries × 3 pages = 240 calls → 500-800 handles únicos.

const FEED_SEARCH_QUERIES = [
  // Live geral + TikTok Shop
  "live tiktok shop brasil agora", "ao vivo tiktok shop", "live shop brasil",
  "tô ao vivo agora", "entra na live", "live vendendo agora", "live promoção",
  "ao vivo vendendo", "live ofertas hoje", "live bazar aovivo",
  "carrinho laranja tiktok", "achados tiktok shop", "promoção live",
  "desconto live", "live achados",
  // Categorias de produto
  "live maquiagem", "live skincare", "live roupa", "live perfume",
  "live tênis", "live bolsa", "live acessórios", "live cabelo",
  "live casa decoração", "live eletrônicos", "live fone bluetooth",
  "live utensílios cozinha", "live air fryer", "live fitness",
  "live suplemento", "live moda feminina", "live moda masculina",
  "live infantil", "live pet", "live brinquedo", "live livro",
  "live jogo", "live informática", "live celular", "live relógio",
  "live óculos", "live joia", "live semi joia", "live bijuteria",
  "live calçados", "live sandália", "live chinelo", "live pijama",
  "live lingerie", "live biquíni", "live maiô", "live vestido",
  "live shorts", "live blusa", "live calça", "live jaqueta",
  "live conjunto moda", "live plus size", "live moda praia",
  // Shop + ofertas
  "live shop achados", "live shop promoção", "live shop vendendo",
  "oferta do dia live", "só hoje live", "live liquidação", "live queima estoque",
  "live frete grátis", "live cupom desconto", "live imperdível",
  "live último dia", "live final de estoque", "live atacado",
  "live outlet", "live limpa estoque",
  // Hashtags
  "#tiktokshopbrasil", "#tiktokshop", "#liveshop", "#liveshopping",
  "#achadinhos", "#achadostiktokshop", "#promocaolive", "#liveaovivo",
  "#ofertarelampago", "#tiktokmademebuyit", "#liveshopbrasil",
  "#aovivo", "#aovivoagora", "#estouaovivo", "#liveagora",
  "#vempralive", "#entranalive", "#brechó", "#bazar",
  "#maquiagemtiktokshop", "#skincaretiktokshop", "#modatiktokshop",
  "#casaetiktokshop", "#cozinhatiktokshop", "#perfumetiktokshop",
  "#cabelotiktokshop", "#achadotiktokshop", "#compreitiktokshop",
  "#gasteinotiktokshop", "#shoptiktokbrasil", "#lojatiktokshop",
  "#pettiktokshop", "#fitnesstiktokshop", "#eletronicostiktokshop",
  "#celulartiktokshop", "#joiastiktokshop", "#relogiostiktokshop",
  "#calcadostiktokshop", "#lingerietiktokshop",
  // Creator / loja terms
  "live influencer brasil", "creator shop brasil", "loja tiktok brasil",
  "vendedora tiktok", "vendedor tiktok", "empreendedora tiktok",
  "dropshipping brasil", "revenda brasil", "atacado tiktok",
  "showroom online", "desapego", "brechó online", "sebo online",
  "loja virtual brasil", "e-commerce brasil live", "seller tiktok shop",
  "afiliado tiktok shop", "comissão tiktok shop", "top seller brasil",
  "melhor vendedora tiktok", "top creator tiktok shop",
  // Regional / gírias
  "comprei e amei tiktok", "tô vendendo live", "vem comprar live",
  "acabou de chegar live", "coleção nova live", "lançamento live",
  "novidade live", "estreia coleção live", "live chegou novidade",
  "loja ao vivo agora", "vendedora ao vivo", "mostrando produto live",
  "prova social live", "depoimento live compra",
];

interface Candidate {
  handle: string;
  nickname: string;
  avatarUrl: string;
  postTitle: string;
}

// Keywords que indicam "live acontecendo agora" no título do post
const LIVE_HINT_RE =
  /ao\s*vivo|aovivo|live\s*agora|estou\s*(em\s*)?live|tô\s*(ao\s*vivo|em\s*live|na\s*live)|entra\s*na\s*live|vem\s*(pra|na)\s*live|live\s*acontecendo|live\s*shop|liveshop|live\s*promoção|live\s*oferta|#aovivo|#liveagora/i;

async function fetchTikwmFeedPage(
  keyword: string,
  cursor: number,
  sortType = 0,
): Promise<Candidate[]> {
  // publish_time=0 = all time. Antes estava 1 (today) que restringia demais.
  const url = `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(
    keyword,
  )}&count=30&cursor=${cursor}&region=br&publish_time=0&sort_type=${sortType}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": randomUA() },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      code?: number;
      data?: {
        videos?: Array<{
          title?: string;
          region?: string;
          author?: { unique_id?: string; nickname?: string; avatar?: string };
        }>;
      };
    };
    if (data.code !== 0) return [];
    return (data.data?.videos ?? [])
      .filter((v) => v.author?.unique_id && (v.region === "BR" || !v.region))
      .map((v) => ({
        handle: v.author!.unique_id!,
        nickname: v.author?.nickname ?? v.author!.unique_id!,
        avatarUrl: v.author?.avatar ?? "",
        postTitle: v.title ?? "",
      }));
  } catch {
    return [];
  }
}

async function fetchTikwmFeedAll(): Promise<{
  all: Candidate[];
  hot: Candidate[];
  stats: { ok: number; empty: number };
}> {
  // Tikwm free tier rate-limita quando >3 req/s.
  // Embaralha queries p/ variar entre runs.
  const shuffled = [...FEED_SEARCH_QUERIES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Cada keyword faz 2 calls: cursor=0 sort=0 (vídeos mais recentes, mais
  // prováveis de ter live acontecendo agora) + cursor random sort random
  // (variação entre runs). Isso dobra a cobertura: ~150×2 = 300 calls.
  //   300 calls @ ~4 req/s (concorrência 3 + gap 300ms) ≈ 75s. Fits em 300s.
  const cursorOptions = [30, 60, 90, 120, 150];
  const tasks: Array<{ keyword: string; cursor: number; sort: number }> = [];
  for (const k of shuffled) {
    // 1ª call: recentes (mais prováveis de estar ao vivo agora)
    tasks.push({ keyword: k, cursor: 0, sort: 0 });
    // 2ª call: variação aleatória pra pegar cauda do feed
    const cursor = cursorOptions[Math.floor(Math.random() * cursorOptions.length)];
    const sort = Math.random() < 0.5 ? 0 : 1;
    tasks.push({ keyword: k, cursor, sort });
  }
  let ok = 0;
  let empty = 0;
  const pages = await mapConcurrent(
    tasks,
    3,
    async (t) => {
      const page = await fetchTikwmFeedPage(t.keyword, t.cursor, t.sort);
      if (page.length > 0) ok++;
      else empty++;
      return page;
    },
    300,
  );
  const flat = pages.flat();
  console.log(`[live-scraper] tikwm feed: ok=${ok} empty=${empty} videos=${flat.length}`);

  // Dedup por handle, mas marca "hot" quem tem LIVE_HINT_RE no título
  const byHandle = new Map<string, Candidate>();
  const hotSet = new Set<string>();
  for (const c of flat) {
    if (!byHandle.has(c.handle)) byHandle.set(c.handle, c);
    if (LIVE_HINT_RE.test(c.postTitle)) hotSet.add(c.handle);
  }
  const all = [...byHandle.values()];
  const hot = all.filter((c) => hotSet.has(c.handle));
  return { all, hot, stats: { ok, empty } };
}

// ── Tikwm graph expansion ────────────────────────────────────────────────────
// Cresce o pool via followings dos seed creators. Creators que seed_creators
// seguem tendem a ser peer streamers do mesmo nicho (BR shop live).

interface TikwmUser {
  unique_id?: string;
  nickname?: string;
  avatar?: string;
}

async function fetchTikwmFollowing(handle: string, cursor = 0): Promise<TikwmUser[]> {
  const url = `https://www.tikwm.com/api/user/following?unique_id=${encodeURIComponent(handle)}&count=30&cursor=${cursor}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": randomUA() },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      code?: number;
      data?: { followings?: TikwmUser[]; users?: TikwmUser[] };
    };
    if (data.code !== 0) return [];
    return data.data?.followings ?? data.data?.users ?? [];
  } catch {
    return [];
  }
}

async function fetchTikwmFollowers(handle: string, cursor = 0): Promise<TikwmUser[]> {
  const url = `https://www.tikwm.com/api/user/followers?unique_id=${encodeURIComponent(handle)}&count=30&cursor=${cursor}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": randomUA() },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      code?: number;
      data?: { followers?: TikwmUser[]; users?: TikwmUser[] };
    };
    if (data.code !== 0) return [];
    return data.data?.followers ?? data.data?.users ?? [];
  } catch {
    return [];
  }
}

// ── Webcast feed endpoints (mobile app discovery) ────────────────────────────
// Tenta endpoints webcast.tiktok.com que NÃO são WAF-bloqueados como
// tiktok.com/live. Mobile app do TikTok usa estes pra descobrir lives.

interface WebcastFeedRoom {
  handle: string;
  roomId: string;
  nickname: string;
  avatarUrl: string;
  hasCommerce?: boolean;
  userCount?: number;
  title?: string;
  coverUrl?: string;
}

async function fetchWebcastFeed(cursor = 0): Promise<WebcastFeedRoom[]> {
  const endpoints = [
    `https://webcast.tiktok.com/webcast/feed/?aid=1988&count=30&region=BR&language=pt&cursor=${cursor}`,
    `https://webcast.tiktok.com/webcast/feed/?aid=1988&count=30&cursor=${cursor}&device_platform=web`,
    `https://webcast.tiktok.com/webcast/region/live_room/?aid=1988&region=BR&count=30`,
    `https://webcast.tiktok.com/webcast/ranklist/room_rank/?aid=1988&region=BR`,
    // Variantes adicionais: endpoints que listam lives por região/categoria
    `https://webcast.tiktok.com/webcast/feed/?aid=1988&count=50&region=BR&cursor=${cursor}`,
    `https://webcast.tiktok.com/webcast/feed/?aid=1988&count=50&language=pt-BR&cursor=${cursor}`,
    `https://webcast.tiktok.com/webcast/ranklist/live/?aid=1988&region=BR&count=50`,
    `https://webcast.tiktok.com/webcast/popular_room_list/?aid=1988&region=BR&count=50`,
    `https://webcast.tiktok.com/webcast/live/region/?aid=1988&region=BR&count=50`,
    `https://webcast.tiktok.com/webcast/recommend/live_list/?aid=1988&region=BR&count=50`,
  ];
  const rooms: WebcastFeedRoom[] = [];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": randomUA(),
          "Accept": "application/json",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text || text.length < 50) continue;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      // Walk recursive — encontra objetos room-like no JSON
      const seen = new Set<string>();
      const walk = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const it of obj) walk(it);
          return;
        }
        const o = obj as Record<string, unknown>;
        const rid = (o.room_id ?? o.roomId ?? o.id_str ?? o.id) as string | number | undefined;
        const owner = (o.owner ?? o.ownerUser ?? o.user ?? o.author) as
          | Record<string, unknown>
          | undefined;
        const uniqueId = (owner?.unique_id ?? owner?.uniqueId ?? o.unique_id ?? o.uniqueId) as
          | string
          | undefined;
        const ridStr = typeof rid === "number" ? String(rid) : rid;
        if (
          typeof ridStr === "string" &&
          ridStr.length >= 12 &&
          /^\d+$/.test(ridStr) &&
          typeof uniqueId === "string" &&
          !seen.has(ridStr)
        ) {
          seen.add(ridStr);
          const blob = JSON.stringify(o);
          const hasCommerce =
            /has_commerce_goods"?\s*:\s*true|goods_num"?\s*:\s*[1-9]|hasCommerce"?\s*:\s*true/.test(
              blob,
            );
          rooms.push({
            handle: uniqueId,
            roomId: ridStr,
            nickname: (owner?.nickname as string) ?? uniqueId,
            avatarUrl:
              ((owner?.avatar_thumb as Record<string, unknown>)?.url_list as string[])?.[0] ??
              (owner?.avatarThumb as string) ??
              "",
            hasCommerce,
            userCount: (o.user_count ?? o.total_user) as number | undefined,
            title: o.title as string | undefined,
            coverUrl: ((o.cover as Record<string, unknown>)?.url_list as string[])?.[0],
          });
        }
        for (const k in o) walk(o[k]);
      };
      walk(data);
    } catch {
      // silent
    }
  }
  return rooms;
}

// ── Lobby discovery (bulk) ───────────────────────────────────────────────────

interface DiscoveredRoom {
  handle: string;
  nickname: string;
  avatarUrl: string;
  roomId?: string;
  hasCommerce?: boolean;
  status?: number;
  userCount?: number;
  title?: string;
  coverUrl?: string;
}

// Extrai rooms do __UNIVERSAL_DATA_FOR_REHYDRATION__ do /live lobby.
// Walk recursivo procurando objetos que parecem "room": têm um id +
// owner.uniqueId. Coleta commerce flag do subtree.
function extractRoomsFromUniversalData(data: unknown): DiscoveredRoom[] {
  const rooms: DiscoveredRoom[] = [];
  const seen = new Set<string>();
  const COMMERCE_RE = /"hasCommerce"\s*:\s*true|"has_commerce_goods"\s*:\s*true|"is_commerce_live"\s*:\s*true|"commerceConfig"|"goods_num"\s*:\s*[1-9]|"shopInfo"|"commerce_live"\s*:\s*true/;

  const walk = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const it of obj) walk(it);
      return;
    }
    const o = obj as Record<string, unknown>;

    const rid = (o.roomId ?? o.room_id ?? o.id_str ?? o.id) as string | number | undefined;
    const owner = (o.owner ?? o.ownerUser ?? o.user ?? o.author ?? o.ownerInfo) as
      | Record<string, unknown>
      | undefined;
    const uniqueId = (owner?.uniqueId ?? owner?.unique_id ?? o.uniqueId ?? o.unique_id) as string | undefined;

    const ridStr = typeof rid === "number" ? String(rid) : rid;
    if (typeof ridStr === "string" && ridStr.length >= 12 && /^\d+$/.test(ridStr) && typeof uniqueId === "string") {
      if (!seen.has(ridStr)) {
        seen.add(ridStr);
        const blob = JSON.stringify(o);
        const hasCommerce = COMMERCE_RE.test(blob);
        const status = (o.status as number | undefined) ?? (o.liveStatus as number | undefined);
        rooms.push({
          handle: uniqueId,
          nickname:
            (owner?.nickname as string | undefined) ??
            (owner?.nickName as string | undefined) ??
            uniqueId,
          avatarUrl:
            (owner?.avatarThumb as string | undefined) ??
            (owner?.avatar_thumb as string | undefined) ??
            (owner?.avatarMedium as string | undefined) ??
            "",
          roomId: ridStr,
          hasCommerce,
          status,
          userCount: (o.userCount ?? o.user_count ?? o.total_user) as number | undefined,
          title: o.title as string | undefined,
          coverUrl: (o.coverUrl ?? o.cover_url) as string | undefined,
        });
      }
    }

    // Também coleta uniqueIds soltos (creators sem room wrapper) — entram no pool
    if (typeof uniqueId === "string" && !seen.has("u:" + uniqueId)) {
      seen.add("u:" + uniqueId);
      rooms.push({
        handle: uniqueId,
        nickname:
          (owner?.nickname as string | undefined) ??
          (owner?.nickName as string | undefined) ??
          uniqueId,
        avatarUrl:
          (owner?.avatarThumb as string | undefined) ??
          (owner?.avatar_thumb as string | undefined) ??
          "",
      });
    }

    for (const k in o) walk(o[k]);
  };
  walk(data);
  return rooms;
}

async function fetchLobbyOnce(url: string): Promise<DiscoveredRoom[]> {
  const deviceId = randomDeviceId();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Cookie": `tt_webid=${deviceId}; tt_webid_v2=${deviceId}; tt-target-idc=useast2a; passport_csrf_token=${deviceId.slice(-16)}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const m = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) return [];
    try {
      return extractRoomsFromUniversalData(JSON.parse(m[1]));
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

// Rotations × 4 URLs × device_id fresh. Se WAF estiver bloqueando tudo,
// queremos falhar rápido (não consumir minutos esperando timeouts).
async function fetchLobbyRotated(): Promise<DiscoveredRoom[]> {
  const LOBBY_URLS = [
    "https://www.tiktok.com/live",
    "https://www.tiktok.com/live?lang=pt-BR",
    "https://www.tiktok.com/live?lang=pt-BR&region=BR",
    "https://www.tiktok.com/discover/live",
  ];
  const rounds = 8;
  const tasks: string[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const u of LOBBY_URLS) tasks.push(u);
  }

  const results = await mapConcurrent(tasks, 10, fetchLobbyOnce, 80);

  // Dedupe por handle — prefere entrada com roomId
  const byHandle = new Map<string, DiscoveredRoom>();
  for (const arr of results) {
    for (const r of arr) {
      const existing = byHandle.get(r.handle);
      if (!existing) {
        byHandle.set(r.handle, r);
      } else if (!existing.roomId && r.roomId) {
        byHandle.set(r.handle, r);
      } else if (existing.roomId && r.roomId && r.hasCommerce && !existing.hasCommerce) {
        byHandle.set(r.handle, r);
      }
    }
  }
  return [...byHandle.values()];
}

// ── Webcast room info (status + commerce + HLS em uma call) ──────────────────

interface FullRoomInfo {
  status: number;
  title?: string;
  coverUrl?: string;
  userCount?: number;
  hasCommerce: boolean;
  hlsUrl?: string;
  flvUrl?: string;
  startedAt?: number;
  likeCount?: number;
}

const pickUrl = (v: unknown): string | undefined => {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const r = v as Record<string, string>;
    return r.FULL_HD1 || r.HD1 || r.SD1 || r.SD2 || Object.values(r)[0];
  }
  return undefined;
};

export async function fetchFullRoomInfo(roomId: string): Promise<FullRoomInfo | null> {
  const url = `https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id=${roomId}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: {
        status?: number;
        title?: string;
        cover?: { url_list?: string[] };
        user_count?: number;
        total_user?: number;
        like_count?: number;
        goods_num?: number;
        has_commerce_goods?: boolean;
        create_time?: number;
        start_time?: number;
        stream_url?: {
          hls_pull_url?: string | Record<string, string>;
          rtmp_pull_url?: string | Record<string, string>;
          flv_pull_url?: string | Record<string, string>;
        };
      };
    };
    const d = data.data;
    if (!d) return null;
    const s = d.stream_url;
    const hasCommerce =
      d.has_commerce_goods === true || (typeof d.goods_num === "number" && d.goods_num > 0);
    return {
      status: d.status ?? 0,
      title: d.title,
      coverUrl: d.cover?.url_list?.[0],
      userCount: d.user_count ?? d.total_user,
      likeCount: d.like_count,
      hasCommerce,
      hlsUrl: pickUrl(s?.hls_pull_url),
      flvUrl: pickUrl(s?.flv_pull_url) ?? pickUrl(s?.rtmp_pull_url),
      startedAt: d.start_time ? d.start_time * 1000 : d.create_time ? d.create_time * 1000 : undefined,
    };
  } catch {
    return null;
  }
}

// Checa se o room ainda está ao vivo. Usado pelo loop de gravação.
//
// IMPORTANTE: só retorna FALSE quando TikTok confirma EXPLICITAMENTE que a
// live acabou (status=4) em DUAS leituras consecutivas — TikTok às vezes
// reporta status=4 transiente durante reconnect/transcode switch, o que
// causava finalização falsa no meio de lives de 3h+.
//
// Qualquer outro valor — timeout, rate limit, status ambíguo (0, 1, 3), null
// — retorna TRUE pra não parar a gravação por falso negativo.
// Até 6 tentativas com 1500ms entre elas (max ~9s) pra achar confirmação.
export async function isLiveActive(roomId: string): Promise<boolean> {
  let endedStreak = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const info = await fetchFullRoomInfo(roomId);
    if (info?.status === 2) return true;
    if (info?.status === 4) {
      endedStreak++;
      if (endedStreak >= 2) return false; // 2 confirmações consecutivas
    } else {
      endedStreak = 0; // resetou — precisa reconfirmar
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 1500));
  }
  // Sem confirmação dupla: assume ainda live.
  return true;
}

// Proof-of-life via stream real: tenta baixar o master HLS e checa se
// contém segmentos (#EXTINF). Se a stream ainda serve bytes, a live está
// viva independentemente do que o JSON status diz. TikTok às vezes reporta
// status=4 por 30s+ durante transcoder transition / reconnect, mas a
// stream continua servindo — isso enganava confirmLiveEnded antes.
export async function probeStreamAlive(roomId: string): Promise<boolean> {
  const info = await fetchFullRoomInfo(roomId);
  const url = info?.hlsUrl || info?.flvUrl;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": randomUA() },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    // HLS: precisa conter #EXTINF (segmentos ativos).
    // FLV direto: qualquer resposta com bytes significativos.
    if (res.headers.get("content-type")?.includes("mpegurl")) {
      const text = await res.text();
      return /\#EXTINF/i.test(text);
    }
    // Para FLV/bytes brutos, só checa que tem conteúdo
    const reader = res.body?.getReader();
    if (!reader) return false;
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && value.length > 0;
  } catch {
    return false;
  }
}

// Confirmação FORTE de encerramento. Combina status JSON + proof-of-life
// via stream bytes. Live só é considerada encerrada quando TODAS estas
// condições se mantêm em DUAS janelas separadas por 15s:
//   1. isLiveActive retorna false (status=4 confirmado 2x consecutivo)
//   2. probeStreamAlive retorna false (HLS sem segmentos OU FLV vazio)
// Qualquer indício de vida em qualquer momento → returna false (continua gravando).
export async function confirmLiveEnded(roomId: string): Promise<boolean> {
  // Janela 1
  const statusFirst = await isLiveActive(roomId);
  if (statusFirst) return false;
  const streamFirst = await probeStreamAlive(roomId);
  if (streamFirst) return false;

  await new Promise((r) => setTimeout(r, 15_000));

  // Janela 2
  const statusSecond = await isLiveActive(roomId);
  if (statusSecond) return false;
  const streamSecond = await probeStreamAlive(roomId);
  if (streamSecond) return false;

  return true;
}

// Exported for recording pipeline / refresh
export async function fetchHlsUrl(
  roomId: string,
): Promise<{ hlsUrl?: string; flvUrl?: string; hasCommerce?: boolean }> {
  const info = await fetchFullRoomInfo(roomId);
  if (!info) return {};
  return { hlsUrl: info.hlsUrl, flvUrl: info.flvUrl, hasCommerce: info.hasCommerce };
}

// ── Fallback: api-live check para seed/manual ────────────────────────────────

interface LiveCheck {
  isLive: boolean;
  error?: boolean;
  roomId?: string;
  title?: string;
  coverUrl?: string;
  userCount?: number;
  enterCount?: number;
  startedAt?: number;
  hasCommerce?: boolean;
}

let _webClient: TikTokWebClient | null = null;
function getWebClient(): TikTokWebClient {
  if (!_webClient) _webClient = new TikTokWebClient();
  return _webClient;
}

const COMMERCE_REGEX =
  /"hasCommerce":true|"is_commerce_live":true|"commerceLive":true|"has_commerce_goods":true|"commerce_live":true|"with_commerce_entry":true|"goods_num":[1-9]|"commerceConfig"|"shopInfo"|"ecpLiveInfo"/i;

interface LiveRoomShape {
  status?: number;
  title?: string;
  coverUrl?: string;
  startTime?: number;
  liveRoomStats?: { userCount?: number; enterCount?: number };
  roomId?: string;
}

// Tenta webcast.tiktok.com direto. Endpoint pode não existir ou ter mudado;
// QUALQUER ambiguidade (shape inesperada, dados ausentes) é tratada como
// erro pra deixar o fallback api-live decidir.
async function checkLiveStatusViaWebcast(handle: string): Promise<LiveCheck> {
  const url = `https://webcast.tiktok.com/webcast/room/info_by_scope/?aid=1988&unique_id=${encodeURIComponent(handle)}&screen_name=${encodeURIComponent(handle)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { isLive: false, error: true };
    const text = await res.text();
    if (!text || text.length < 50) return { isLive: false, error: true };
    let d: unknown;
    try { d = JSON.parse(text); } catch { return { isLive: false, error: true }; }
    const raw = d as { data?: { status?: number; id_str?: string; room_id?: string; title?: string; user_count?: number; like_count?: number; has_commerce_goods?: boolean; goods_num?: number; create_time?: number } };
    const rd = raw.data;
    // Se não tem `data` ou não tem `status` sinalizado, endpoint não
    // respondeu como esperado — vai pra fallback.
    if (!rd || typeof rd.status !== "number") return { isLive: false, error: true };
    if (rd.status !== 2) return { isLive: false };
    const roomId = rd.id_str ?? rd.room_id;
    if (!roomId) return { isLive: false, error: true };
    const blob = text;
    return {
      isLive: true,
      roomId,
      title: rd.title,
      userCount: rd.user_count,
      enterCount: rd.like_count,
      startedAt: rd.create_time ? rd.create_time * 1000 : undefined,
      hasCommerce: rd.has_commerce_goods === true || (typeof rd.goods_num === "number" && rd.goods_num > 0) || COMMERCE_REGEX.test(blob),
    };
  } catch {
    return { isLive: false, error: true };
  }
}

// ── RapidAPI integration (tiktok-scraper7 ou tiktok-api23) ─────────────────
// Provider com proxies residenciais — contorna o WAF que bloqueia Vercel IPs.
// Settings field: tiktokScraperApiKey (UI: /ugc/settings).
// Host padrão: tiktok-scraper7.p.rapidapi.com. Pode trocar via env RAPIDAPI_TIKTOK_HOST.
// Suporta tiktok-scraper7 (wraps tikwm) e tiktok-api23 (endpoints /api/live/*).

const RAPIDAPI_HOST_DEFAULT = process.env.RAPIDAPI_TIKTOK_HOST ?? "tiktok-scraper7.p.rapidapi.com";

export interface RapidApiLive {
  roomId: string;
  handle: string;
  nickname: string;
  avatarUrl: string;
  title?: string;
  coverUrl?: string;
  userCount?: number;
  likeCount?: number;
  hasCommerce: boolean;
  hlsUrl?: string;
  startedAt?: number;
}

// Lista lives ativas por região. Bypass total do WAF — API paga acessa
// endpoints internos do TikTok com proxies residenciais.
// api23 tem endpoint dedicado; scraper7 NÃO expõe live discovery — nesse caso
// retorna vazio e confia no fetchTikwmFeedAll + checkLiveViaRapidApi per-user.
async function fetchRapidApiLiveFeed(apiKey: string, host: string): Promise<RapidApiLive[]> {
  const rooms: RapidApiLive[] = [];
  const seen = new Set<string>();
  const provider = providerFromHost(host);

  // scraper7 não tem "lista todas as lives" — skip pra evitar falsos positivos
  // (/feed/list devolve vídeos, não rooms; walk confundia os dois)
  if (provider !== "api23") return [];

  const endpoints = [
        `https://${host}/api/live/feed?region=BR&limit=50`,
        `https://${host}/api/live/feed?region=BR&limit=50&page=2`,
        `https://${host}/api/live/feed?region=BR&limit=50&page=3`,
        `https://${host}/api/live/feed?limit=50`,
        `https://${host}/api/live/feed?limit=50&page=2`,
        `https://${host}/api/live/popular?region=BR&limit=50`,
        `https://${host}/api/live/ranklist?region=BR`,
      ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": host,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      // Walk recursive — RapidAPI providers variam no shape exato
      const walk = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { for (const it of obj) walk(it); return; }
        const o = obj as Record<string, unknown>;
        const rid = (o.room_id ?? o.roomId ?? o.id_str ?? o.id) as string | number | undefined;
        const owner = (o.owner ?? o.ownerUser ?? o.user ?? o.author) as Record<string, unknown> | undefined;
        const uniqueId = (owner?.unique_id ?? owner?.uniqueId ?? o.unique_id ?? o.uniqueId) as string | undefined;
        const ridStr = typeof rid === "number" ? String(rid) : rid;
        if (typeof ridStr === "string" && ridStr.length >= 12 && /^\d+$/.test(ridStr) && typeof uniqueId === "string" && !seen.has(ridStr)) {
          seen.add(ridStr);
          const blob = JSON.stringify(o);
          const hasCommerce = /has_commerce_goods"?\s*:\s*true|goods_num"?\s*:\s*[1-9]|hasCommerce"?\s*:\s*true|is_commerce_live"?\s*:\s*true/.test(blob);
          const streamUrl = o.stream_url as Record<string, unknown> | undefined;
          const hlsRaw = streamUrl?.hls_pull_url;
          const hls = typeof hlsRaw === "string" ? hlsRaw : (hlsRaw as Record<string, string> | undefined)?.FULL_HD1 ?? (hlsRaw as Record<string, string> | undefined)?.HD1;
          rooms.push({
            roomId: ridStr,
            handle: uniqueId,
            nickname: (owner?.nickname as string) ?? uniqueId,
            avatarUrl: ((owner?.avatar_thumb as Record<string, unknown>)?.url_list as string[])?.[0] ?? (owner?.avatarThumb as string) ?? "",
            title: o.title as string | undefined,
            coverUrl: ((o.cover as Record<string, unknown>)?.url_list as string[])?.[0] ?? (o.cover_url as string | undefined),
            userCount: (o.user_count ?? o.total_user) as number | undefined,
            likeCount: (o.like_count ?? o.total_like) as number | undefined,
            hasCommerce,
            hlsUrl: hls,
            startedAt: ((o.start_time ?? o.create_time) as number | undefined) ? ((o.start_time ?? o.create_time) as number) * 1000 : undefined,
          });
        }
        for (const k in o) walk(o[k]);
      };
      walk(data);
    } catch {
      // silent
    }
  }

  return rooms;
}

async function checkLiveViaRapidApi(apiKey: string, host: string, handle: string): Promise<LiveCheck> {
  const provider = providerFromHost(host);
  // Lista de URLs a tentar. api23 tem endpoint dedicado; scraper7 não tem
  // check-alive oficial, então testamos variantes de /live/* e /user/info
  // (tikwm às vezes devolve liveRoomId embedded).
  const urls = provider === "api23"
    ? [`https://${host}/api/live/check-alive?uniqueId=${encodeURIComponent(handle)}`]
    : [
        // scraper7 wraps tikwm — endpoint oficial tikwm pra live check
        `https://${host}/api/user/live?unique_id=${encodeURIComponent(handle)}`,
        `https://${host}/user/live?unique_id=${encodeURIComponent(handle)}`,
      ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": host,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      let d: unknown;
      try { d = JSON.parse(text); } catch { continue; }
      const raw = d as {
        code?: number;
        msg?: string;
        data?: {
          status?: number;
          room_id?: string | number;
          title?: string;
          cover_url?: string;
          user_count?: number;
          like_count?: number;
          create_time?: number;
          has_commerce_goods?: boolean;
          goods_num?: number;
          room?: { id_str?: string; title?: string; user_count?: number; like_count?: number; has_commerce_goods?: boolean; goods_num?: number; create_time?: number };
          user?: { roomId?: string; liveRoomId?: string; room_id?: string | number };
          liveRoom?: { status?: number; roomId?: string; title?: string };
        };
        isLive?: boolean;
        roomId?: string;
      };

      // api23 shape
      if (raw.data?.status === 2 && raw.data?.room?.id_str) {
        const room = raw.data.room;
        return {
          isLive: true,
          roomId: room.id_str!,
          title: room.title,
          userCount: room.user_count,
          enterCount: room.like_count,
          startedAt: room.create_time ? room.create_time * 1000 : undefined,
          hasCommerce: room.has_commerce_goods === true || (typeof room.goods_num === "number" && room.goods_num > 0) || COMMERCE_REGEX.test(text),
        };
      }

      // tikwm/scraper7 /api/user/live shape — code:0 data com room_id direto
      if (raw.code === 0 && raw.data?.room_id) {
        const rid = String(raw.data.room_id);
        if (/^\d{10,}$/.test(rid)) {
          return {
            isLive: true,
            roomId: rid,
            title: raw.data.title,
            coverUrl: raw.data.cover_url,
            userCount: raw.data.user_count,
            enterCount: raw.data.like_count,
            startedAt: raw.data.create_time ? raw.data.create_time * 1000 : undefined,
            hasCommerce: raw.data.has_commerce_goods === true || (typeof raw.data.goods_num === "number" && raw.data.goods_num > 0) || COMMERCE_REGEX.test(text),
          };
        }
      }

      // tikwm retorna code !== 0 quando user não tá live (definitivo)
      if (typeof raw.code === "number" && raw.code !== 0) {
        return { isLive: false };
      }

      // user/info shape — pode vir liveRoomId ou room_id embedded
      const userRoom = raw.data?.user?.roomId ?? raw.data?.user?.liveRoomId ?? raw.data?.user?.room_id;
      if (userRoom && /^\d{10,}$/.test(String(userRoom))) {
        return {
          isLive: true,
          roomId: String(userRoom),
          hasCommerce: COMMERCE_REGEX.test(text),
        };
      }

      // liveRoom shape (api-live.tiktok.com wrapped)
      if (raw.data?.liveRoom?.status === 2 && raw.data?.liveRoom?.roomId) {
        return {
          isLive: true,
          roomId: raw.data.liveRoom.roomId,
          title: raw.data.liveRoom.title,
          hasCommerce: COMMERCE_REGEX.test(text),
        };
      }

      // Resposta válida mas user offline → definitivo
      if (raw.data && !raw.data.status && !raw.data.liveRoom && !raw.data.user?.roomId && !raw.data.room_id) {
        return { isLive: false };
      }
    } catch {
      // tenta próximo
    }
  }
  return { isLive: false, error: true };
}

async function checkLiveStatus(handle: string): Promise<LiveCheck> {
  // 0. Se tiver RapidAPI key + provider tem endpoint de live check, tenta ela
  // primeiro (proxy residencial, bypassa WAF). scraper7 NÃO tem live endpoint
  // (só /user/info com dados de perfil), então skip pra não gastar cota.
  if (_runApiKey && providerFromHost(_runApiHost) === "api23") {
    const r = await checkLiveViaRapidApi(_runApiKey, _runApiHost, handle);
    if (r.isLive) return r;
    // Só short-circuit se confirmou offline sem erro (resposta definitiva)
    if (!r.error) return r;
  }

  // 1ª tentativa: webcast direto (pouco WAF-blocked quando funciona).
  //   Só aceita como resposta definitiva se VIU a live. Qualquer outra
  //   coisa cai pro fallback (pode ser endpoint retornando shape nova).
  const webcastResult = await checkLiveStatusViaWebcast(handle);
  if (webcastResult.isLive) return webcastResult;

  // 2ª tentativa (fallback): api-live via tiktok-live-connector (WAF-sensível)
  const client = getWebClient();
  // Timeout hard em 5s: request pendurado pelo WAF não pode travar o worker
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), ms),
      ),
    ]);
  try {
    const r = await withTimeout(
      client.fetchRoomInfoFromApiLive.call({ uniqueId: handle }),
      5_000,
    );
    const rr = r as { data?: { liveRoom?: LiveRoomShape; user?: { roomId?: string } } };
    const lr = rr?.data?.liveRoom;
    if (!lr || lr.status !== 2) return { isLive: false };
    const blob = JSON.stringify(rr.data ?? {});
    return {
      isLive: true,
      roomId: rr.data?.user?.roomId ?? lr.roomId,
      title: lr.title,
      coverUrl: lr.coverUrl,
      userCount: lr.liveRoomStats?.userCount,
      enterCount: lr.liveRoomStats?.enterCount,
      startedAt: lr.startTime ? lr.startTime * 1000 : undefined,
      hasCommerce: COMMERCE_REGEX.test(blob),
    };
  } catch {
    return { isLive: false, error: true };
  }
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  delayMs = 0,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function scrapeLiveSessions(
  _keywords: string[],
  apiKey?: string,
): Promise<LiveScrapeResult> {
  const t0 = Date.now();
  _runApiKey = apiKey; // disponibiliza pra checkLiveStatus usar via RapidAPI
  _runApiHost = RAPIDAPI_HOST_DEFAULT;

  // 0. Seed pool (idempotente)
  await prisma.ugcKnownCreator
    .createMany({
      data: SEED_SHOP_CREATORS.map((h) => ({ handle: h, region: "BR", source: "seed" })),
      skipDuplicates: true,
    })
    .catch(() => null);

  // 1a. BULK DISCOVERY — paralelo:
  //     - webcast/feed endpoints (mobile app discovery, não WAF)
  //     - lobby HTML rotado (pode estar bloqueado)
  //     - graph expansion: followings dos seed + known-live (tikwm)
  console.log("[live-scraper] discovery start...");

  // Handles seed p/ graph expansion
  const seedForGraph = await prisma.ugcKnownCreator.findMany({
    where: {
      region: "BR",
      OR: [{ source: "seed" }, { source: "manual" }, { lastSeenLive: { not: null } }],
    },
    orderBy: [{ lastSeenLive: { sort: "desc", nulls: "last" } }],
    take: 15,
  });

  // Discovery em paralelo de TODAS as fontes:
  //   - RapidAPI live feed (proxy residencial, bypassa WAF) — PRINCIPAL se key
  //   - webcast/feed com múltiplos cursors (WAF-blocked em Vercel)
  //   - lobby HTML rotado (idem)
  //   - tikwm feed search (sempre funciona, candidatos secundários)
  const webcastCursors = [0, 30, 60, 90, 120];
  const webcastRoomsAcc: WebcastFeedRoom[] = [];
  const [rapidApiRooms, _webcastBatch, lobbyRooms, feedResult] = await Promise.all([
    apiKey ? fetchRapidApiLiveFeed(apiKey, _runApiHost).catch(() => [] as RapidApiLive[]) : Promise.resolve([] as RapidApiLive[]),
    (async () => {
      for (const c of webcastCursors) {
        const batch = await fetchWebcastFeed(c).catch(() => [] as WebcastFeedRoom[]);
        webcastRoomsAcc.push(...batch);
      }
    })(),
    fetchLobbyRotated().catch(() => [] as DiscoveredRoom[]),
    fetchTikwmFeedAll(),
  ]);
  console.log(
    `[live-scraper] rapidapi feed: rooms=${rapidApiRooms.length} (apiKey=${apiKey ? "set" : "none"})`,
  );
  // Dedupe por roomId
  const webcastSeen = new Set<string>();
  const webcastRooms: WebcastFeedRoom[] = [];
  for (const r of webcastRoomsAcc) {
    if (!webcastSeen.has(r.roomId)) {
      webcastSeen.add(r.roomId);
      webcastRooms.push(r);
    }
  }
  // Graph followings ficou desativado (API tikwm não suporta)
  const graphCandidates: DiscoveredRoom[] = feedResult.all.map((c) => ({
    handle: c.handle,
    nickname: c.nickname,
    avatarUrl: c.avatarUrl,
  }));
  const hotCandidates = feedResult.hot.map((c) => c.handle);
  console.log(
    `[live-scraper] feed: all=${feedResult.all.length} hot=${feedResult.hot.length}`,
  );

  // Merge webcast rooms into lobbyRooms shape
  const webcastAsLobby: DiscoveredRoom[] = webcastRooms.map((w) => ({
    handle: w.handle,
    nickname: w.nickname,
    avatarUrl: w.avatarUrl,
    roomId: w.roomId,
    hasCommerce: w.hasCommerce,
    userCount: w.userCount,
    title: w.title,
    coverUrl: w.coverUrl,
  }));

  // Merge RapidAPI rooms também — rooms com roomId + commerce pré-verificado
  const rapidApiAsLobby: DiscoveredRoom[] = rapidApiRooms.map((r) => ({
    handle: r.handle,
    nickname: r.nickname,
    avatarUrl: r.avatarUrl,
    roomId: r.roomId,
    hasCommerce: r.hasCommerce,
    userCount: r.userCount,
    title: r.title,
    coverUrl: r.coverUrl,
  }));

  // Combina todas as fontes de discovery (RapidAPI tem prioridade — vem com
  // roomId + commerce verificados)
  const allDiscoveredMap = new Map<string, DiscoveredRoom>();
  for (const r of rapidApiAsLobby) allDiscoveredMap.set(r.handle, r);
  for (const r of webcastAsLobby) {
    const ex = allDiscoveredMap.get(r.handle);
    if (!ex || (!ex.roomId && r.roomId)) allDiscoveredMap.set(r.handle, r);
  }
  for (const r of lobbyRooms) {
    const ex = allDiscoveredMap.get(r.handle);
    if (!ex || (!ex.roomId && r.roomId)) allDiscoveredMap.set(r.handle, r);
  }
  for (const r of graphCandidates) {
    if (!allDiscoveredMap.has(r.handle)) allDiscoveredMap.set(r.handle, r);
  }
  const allDiscovered = [...allDiscoveredMap.values()];
  const lobbyWithRoomId = allDiscovered.filter((r) => r.roomId);
  console.log(
    `[live-scraper] discovery: webcast=${webcastRooms.length} lobby=${lobbyRooms.length} graph=${graphCandidates.length} total=${allDiscovered.length} withRoomId=${lobbyWithRoomId.length} (elapsed=${Date.now() - t0}ms)`,
  );

  // Alias para manter nome usado abaixo
  const lobbyRoomsAll = allDiscovered;

  // 2. Persiste todos os handles descobertos
  if (lobbyRoomsAll.length > 0) {
    await prisma.ugcKnownCreator
      .createMany({
        data: lobbyRoomsAll.map((r) => ({
          handle: r.handle,
          nickname: r.nickname,
          avatarUrl: r.avatarUrl,
          region: "BR",
          source: r.roomId ? "lobby" : "feed_search",
        })),
        skipDuplicates: true,
      })
      .catch(() => null);
  }

  // 3. Para cada roomId do lobby → chama webcast/room/info (autoritativo)
  const t1 = Date.now();
  const roomInfos = await mapConcurrent(
    lobbyWithRoomId,
    10,
    async (r) => {
      const info = await fetchFullRoomInfo(r.roomId!);
      return { room: r, info };
    },
    50,
  );
  console.log(
    `[live-scraper] fetched ${roomInfos.length} room infos (elapsed=${Date.now() - t1}ms)`,
  );

  // 4. FALLBACK: seed + manual + visto-live recentemente que NÃO apareceram
  //    no lobby — tenta via api-live com rate limit pesado.
  // Fallback com ORDEM EMBARALHADA pra variar quem é checado entre runs:
  //  1. HOT candidates (post title com "ao vivo agora" etc) — prioritário
  //  2. Seed/manual/seenLive — sempre incluídos, embaralhados
  //  3. Resto do feed search — embaralhado
  //  Cap 150 handles. WAF deixa ~30% passar = ~45 checks = ~5-10 lives.
  const foundWithRoomId = new Set(lobbyWithRoomId.map((r) => r.handle));
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Pool COMPLETO do DB: seed + manual + seen + feed_search + lobby accumulated
  //  → cresce ao longo de runs, permite shuffling de um pool cada vez maior.
  const highPriority = await prisma.ugcKnownCreator.findMany({
    where: {
      region: "BR",
      OR: [
        { source: "seed" },
        { source: "manual" },
        { lastSeenLive: { not: null } },
      ],
    },
    take: 500,
  });

  const dbPool = await prisma.ugcKnownCreator.findMany({
    where: { region: "BR" },
    take: 2000,
    orderBy: [{ lastChecked: "asc" }],
  });

  const hotShuffled = shuffle(hotCandidates.filter((h) => !foundWithRoomId.has(h)));
  const seedShuffled = shuffle(
    highPriority.map((h) => h.handle).filter((h) => !foundWithRoomId.has(h)),
  );
  const feedShuffled = shuffle(
    graphCandidates
      .map((g) => g.handle)
      .filter((h) => !foundWithRoomId.has(h) && !hotCandidates.includes(h)),
  );
  const dbShuffled = shuffle(
    dbPool.map((p) => p.handle).filter((h) => !foundWithRoomId.has(h)),
  );

  // Ordem: hot (mais prováveis de live) → DB pool (LRU, rotaciona entre runs)
  //        → seed priority → resto do feed novo
  //  DB pool vem antes do feed pois o feed tende a cachear mesmos handles.
  // Cap 1200: com checkLiveStatus agora tentando webcast PRIMEIRO (muito
  //   menos WAF-blocked), cada check custa ~0.5-1s. Pool grande faz
  //   diferença. Concorrência 10 + gap 100ms: 1200/10 × 1.1s ≈ 132s.
  const fallbackHandles = [
    ...new Set([...hotShuffled, ...dbShuffled, ...seedShuffled, ...feedShuffled]),
  ].slice(0, 1200);
  console.log(
    `[live-scraper] fallback: hot=${hotShuffled.length} seed=${seedShuffled.length} feed=${feedShuffled.length} db=${dbShuffled.length} -> ${fallbackHandles.length}`,
  );
  console.log(`[live-scraper] fallback api-live checks: ${fallbackHandles.length}`);

  // Concorrência 10 + gap 100ms: com 1200 handles, consome ~132s.
  const fallbackChecks = await mapConcurrent(
    fallbackHandles,
    10,
    async (handle) => {
      const check = await checkLiveStatus(handle);
      let info: FullRoomInfo | null = null;
      if (check.isLive && check.roomId) {
        info = await fetchFullRoomInfo(check.roomId);
      }
      return { handle, check, info };
    },
    100,
  );

  // Debug: quantos dos 1200 foram identificados como live, quantos erro, etc.
  const fallbackLive = fallbackChecks.filter((c) => c.check.isLive).length;
  const fallbackErr = fallbackChecks.filter((c) => c.check.error).length;
  const fallbackCommerce = fallbackChecks.filter((c) => {
    const hc = c.info?.hasCommerce ?? c.check.hasCommerce ?? false;
    return c.check.isLive && hc;
  }).length;
  console.log(
    `[live-scraper] fallback result: live=${fallbackLive} commerce=${fallbackCommerce} errors=${fallbackErr} / ${fallbackChecks.length}`,
  );

  // 5. Merge + filtro commerce estrito
  const finals = new Map<string, ScrapedLive & { __hasCommerce: boolean }>();
  let liveWithCommerce = 0;
  let liveWithoutCommerce = 0;
  let checkErrors = 0;

  // Filtro commerce ESTRITO: só entra live com botão de compra (TikTok Shop).
  // Expansão de pool vem do cap 800 + feed 2x — aumenta discovery sem
  // relaxar o filtro de qualidade.
  for (const { room, info } of roomInfos) {
    if (!info) continue;
    if (info.status !== 2) continue;
    if (info.hasCommerce) {
      liveWithCommerce++;
    } else {
      liveWithoutCommerce++;
      continue;
    }
    const viewerCount = info.userCount ?? room.userCount ?? 0;
    const likeCount = info.likeCount ?? 0;
    finals.set(room.handle, {
      roomId: room.roomId!,
      title: info.title ?? room.title ?? "",
      hostHandle: room.handle,
      hostNickname: room.nickname,
      hostAvatarUrl: room.avatarUrl,
      viewerCount,
      totalViewers: viewerCount,
      likeCount,
      estimatedOrders: 0,
      productCount: 1,
      products: [],
      isLive: true,
      startedAt: info.startedAt ? new Date(info.startedAt).toISOString() : undefined,
      hlsUrl: info.hlsUrl,
      flvUrl: info.flvUrl,
      liveUrl: `https://www.tiktok.com/@${room.handle}/live`,
      thumbnailUrl: info.coverUrl ?? room.coverUrl ?? room.avatarUrl,
      salesScore: calcSalesScore({ viewerCount, likeCount, isLive: true }),
      __hasCommerce: true,
    });
  }

  for (const { handle, check, info } of fallbackChecks) {
    if (check.error) checkErrors++;
    if (!check.isLive) continue;
    const hasCommerce = info?.hasCommerce ?? check.hasCommerce ?? false;
    if (!hasCommerce) {
      liveWithoutCommerce++;
      continue;
    }
    if (finals.has(handle)) continue;
    liveWithCommerce++;
    const viewerCount = info?.userCount ?? check.userCount ?? 0;
    const likeCount = info?.likeCount ?? check.enterCount ?? 0;
    finals.set(handle, {
      roomId: check.roomId ?? `live_${handle}_${Date.now()}`,
      title: check.title ?? info?.title ?? "",
      hostHandle: handle,
      hostNickname: handle,
      hostAvatarUrl: "",
      viewerCount,
      totalViewers: viewerCount,
      likeCount,
      estimatedOrders: 0,
      productCount: 1,
      products: [],
      isLive: true,
      startedAt: check.startedAt ? new Date(check.startedAt).toISOString() : undefined,
      hlsUrl: info?.hlsUrl,
      flvUrl: info?.flvUrl,
      liveUrl: `https://www.tiktok.com/@${handle}/live`,
      thumbnailUrl: info?.coverUrl ?? check.coverUrl ?? "",
      salesScore: calcSalesScore({ viewerCount, likeCount, isLive: true }),
      __hasCommerce: true,
    });
  }

  const finalLives = [...finals.values()]
    .map(({ __hasCommerce: _, ...rest }) => rest)
    .sort((a, b) => b.viewerCount - a.viewerCount);

  // 6. Update pool: lastChecked para tudo, lastSeenLive para os live
  const now = new Date();
  const allChecked = [
    ...lobbyWithRoomId.map((r) => r.handle),
    ...fallbackHandles,
  ];
  if (allChecked.length > 0) {
    await prisma.ugcKnownCreator
      .updateMany({
        where: { handle: { in: allChecked } },
        data: { lastChecked: now },
      })
      .catch(() => null);
  }
  // Atualiza o histórico do creator (peak, último início, título, etc).
  // updateMany não faz per-row, então fazemos um por live (N pequeno).
  for (const l of finalLives) {
    await prisma.ugcKnownCreator
      .update({
        where: { handle: l.hostHandle },
        data: {
          lastSeenLive: now,
          liveCount: { increment: 1 },
          lastLiveStartedAt: l.startedAt ? new Date(l.startedAt) : now,
          lastLiveTitle: l.title?.slice(0, 200) ?? null,
          hasCommerce: true,
        },
      })
      .catch(() => null);
    // peak: set apenas se maior
    await prisma.$executeRaw`
      UPDATE ugc_known_creators
      SET "peakViewers" = GREATEST("peakViewers", ${l.viewerCount})
      WHERE handle = ${l.hostHandle}
    `.catch(() => null);
  }

  console.log(
    `[live-scraper] DONE in ${Date.now() - t0}ms: total=${lobbyRoomsAll.length}, withId=${lobbyWithRoomId.length}, withCommerce=${liveWithCommerce}, final=${finalLives.length}`,
  );

  return {
    lives: finalLives,
    totalFound: finalLives.length,
    scrapedAt: new Date().toISOString(),
    debug: {
      keywordsSearched: [
        `rapidApi=${rapidApiRooms.length}`,
        `webcast=${webcastRooms.length}`,
        `lobby=${lobbyRooms.length}`,
        `feed=${feedResult.all.length}`,
        `hot=${feedResult.hot.length}`,
      ],
      candidatesFound: lobbyRoomsAll.length,
      verifiedLive: finalLives.length + liveWithoutCommerce,
      checkErrors,
      liveWithCommerce,
      liveWithoutCommerce,
      usedMock: false,
      lobbyRoomsFound: lobbyRoomsAll.length,
      lobbyRoomsWithId: lobbyWithRoomId.length,
      fallbackChecked: fallbackHandles.length,
    },
  };
}
