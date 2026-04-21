#!/usr/bin/env node
// TikTok Live Verification Daemon — roda na máquina do usuário com IP
// residencial. Expõe HTTP em 127.0.0.1:3333 pra o front chamar via CORS.
//
// Duas vias de verificação:
//   FAST — candidate já tem roomId cacheado → só chama webcast/room/info/
//          (endpoint que o Akamai NÃO rate-limita).
//   SLOW — candidate sem roomId → HTML-scrape /@handle/live pra extrair
//          roomId. É a fonte do rate limit; throttled pesado.

import http from "node:http";

const PORT = 3333;
const HOST = "127.0.0.1";
const VERSION = "2.0.0";

const ALLOWED_ORIGINS = new Set([
  "https://motion-transfer-saas.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
];
const randomUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// Cap de quantos handles desconhecidos vamos resolver por run. O /live HTML
// é o único endpoint Akamai-protegido: mais que isso → IP ban temporário.
const MAX_UNKNOWN_RESOLVE = 30;

// Jitter humano no gap, pra randomizar o padrão temporal.
const jitter = (baseMs, spread = 0.5) => {
  const delta = baseMs * spread;
  return baseMs - delta + Math.random() * 2 * delta;
};

// Cookie jar compartilhado entre requests do slow path — algumas respostas
// do TikTok setam msToken/ttwid que reduzem suspeita de bot no próximo hit.
const cookieJar = new Map();
function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorbSetCookie(res) {
  const sc = res.headers.get("set-cookie");
  if (!sc) return;
  for (const line of sc.split(/,(?=[^;]+=)/)) {
    const [kv] = line.trim().split(";");
    const [k, v] = kv.split("=");
    if (k && v) cookieJar.set(k.trim(), v.trim());
  }
}

let warmupDone = false;
async function warmupSession() {
  if (warmupDone) return;
  try {
    const res = await fetch("https://www.tiktok.com/", {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
      },
      signal: AbortSignal.timeout(10_000),
    });
    absorbSetCookie(res);
    await res.text().catch(() => null);
    warmupDone = true;
    console.log(`[warmup] ok, cookies=${cookieJar.size}`);
  } catch (err) {
    console.log(`[warmup] failed: ${err.message}`);
  }
}

function candidateHandleToRegex(h) {
  return String(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const pickUrl = (v) => {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    return v.FULL_HD1 || v.HD1 || v.SD1 || v.SD2 || Object.values(v)[0];
  }
  return undefined;
};

// Detecta resposta-bloqueio Akamai mesmo com status 200/403/etc.
function isBlocked(status, html) {
  if (status === 403) return true;
  if (!html) return false;
  if (html.length < 5000) return true; // página real tem >100KB; challenge tem 400-2000B
  if (/Access Denied|errors\.edgesuite\.net|_wafchallengeid|waf-aiso/i.test(html)) return true;
  if (/captcha|tiktok-verify-page|ip restriction/i.test(html)) return true;
  return false;
}

async function fetchRoomByHandle(handle) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}/live`;
  try {
    const headers = {
      "User-Agent": randomUA(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Referer": "https://www.tiktok.com/",
      "Cache-Control": "max-age=0",
    };
    if (cookieJar.size > 0) headers["Cookie"] = cookieHeader();
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    absorbSetCookie(res);
    const html = await res.text();
    if (isBlocked(res.status, html)) return { blocked: true };
    if (!res.ok) return { error: true };

    const handleEsc = candidateHandleToRegex(handle);
    const anchorRe = new RegExp(
      `"uniqueId"\\s*:\\s*"${handleEsc}"[\\s\\S]{0,400}?"roomId"\\s*:\\s*"(\\d{15,}|)"`,
      "i",
    );
    const anchorMatch = html.match(anchorRe);
    let roomId = null;
    if (anchorMatch) {
      roomId = anchorMatch[1] || null;
    } else {
      const firstNonEmpty = html.match(/"roomId"\s*:\s*"(\d{15,})"/);
      if (firstNonEmpty) roomId = firstNonEmpty[1];
      else if (/"roomId"\s*:\s*""/.test(html)) roomId = null;
      else return { error: true };
    }

    if (!roomId) return { isLive: false };

    const statusMatch = html.match(new RegExp(`"roomId"\\s*:\\s*"${roomId}"[\\s\\S]{0,300}?"status"\\s*:\\s*(\\d+)`));
    const status = statusMatch ? Number(statusMatch[1]) : 2;
    if (status !== 2) return { isLive: false };

    return { isLive: true, roomId };
  } catch {
    return { error: true };
  }
}

async function fetchFullRoomInfo(roomId) {
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
    const data = await res.json();
    const d = data?.data;
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

function buildLive(candidate, roomId, full) {
  return {
    roomId,
    hostHandle: candidate.handle,
    hostNickname: candidate.nickname || candidate.handle,
    hostAvatarUrl: candidate.avatarUrl || "",
    title: full.title || "",
    viewerCount: full.userCount ?? 0,
    likeCount: full.likeCount ?? 0,
    hlsUrl: full.hlsUrl,
    flvUrl: full.flvUrl,
    thumbnailUrl: full.coverUrl || candidate.avatarUrl || "",
    startedAt: full.startedAt ? new Date(full.startedAt).toISOString() : null,
    hasCommerce: true,
  };
}

async function verifyWithKnownRoomId(candidate) {
  const roomId = candidate.roomId;
  const full = await fetchFullRoomInfo(roomId);
  if (!full) {
    // roomId cacheado pode ter expirado; retorna "stale" pra front não tentar
    // de novo a mesma rota. Não é bloqueio do Akamai — é vida normal da live.
    return { handle: candidate.handle, outcome: "stale-cache" };
  }
  if (full.status !== 2) return { handle: candidate.handle, outcome: "offline" };
  if (!full.hasCommerce) return { handle: candidate.handle, outcome: "no-commerce", roomId };
  return { handle: candidate.handle, outcome: "live", live: buildLive(candidate, roomId, full) };
}

async function verifyUnknown(candidate) {
  const byHandle = await fetchRoomByHandle(candidate.handle);
  if (byHandle.blocked) return { handle: candidate.handle, outcome: "blocked" };
  if (byHandle.error) return { handle: candidate.handle, outcome: "error" };
  if (!byHandle.isLive) return { handle: candidate.handle, outcome: "offline" };

  const roomId = byHandle.roomId;
  const full = await fetchFullRoomInfo(roomId);
  if (!full) return { handle: candidate.handle, outcome: "error" };
  if (full.status !== 2) return { handle: candidate.handle, outcome: "offline" };
  if (!full.hasCommerce) return { handle: candidate.handle, outcome: "no-commerce", roomId };
  return { handle: candidate.handle, outcome: "live", live: buildLive(candidate, roomId, full) };
}

async function runPool(items, worker, concurrency, gapMs, maxBlocked = 5) {
  const results = [];
  const queue = [...items];
  let blockedStreak = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      // Circuit breaker: se N blocked seguidos, para esse pool pra evitar
      // IP ban total. O que sobra volta como "skipped".
      if (blockedStreak >= maxBlocked) {
        const leftover = queue.splice(0).map((c) => ({ handle: c.handle, outcome: "skipped" }));
        results.push(...leftover);
        return;
      }
      const c = queue.shift();
      if (!c) break;
      const r = await worker(c);
      results.push(r);
      if (r.outcome === "blocked") {
        blockedStreak++;
        // Backoff exponencial: 8s → 16s → 32s → 60s (cap).
        await new Promise((res) => setTimeout(res, Math.min(8000 * 2 ** (blockedStreak - 1), 60000)));
      } else {
        blockedStreak = 0;
        if (gapMs > 0) await new Promise((res) => setTimeout(res, jitter(gapMs)));
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function verifyBatch(candidates) {
  const known = candidates.filter(
    (c) => c.roomId && typeof c.roomId === "string" && /^\d{15,}$/.test(c.roomId),
  );
  const unknownAll = candidates.filter(
    (c) => !(c.roomId && typeof c.roomId === "string" && /^\d{15,}$/.test(c.roomId)),
  );
  // Limita slow path — resto é descartado dessa run e volta em próximas (a cada
  // ingest, handles verificados ganham roomId cache e saem do slow path).
  const unknown = unknownAll.slice(0, MAX_UNKNOWN_RESOLVE);
  const deferred = unknownAll.slice(MAX_UNKNOWN_RESOLVE);

  console.log(
    `[verify] start: ${candidates.length} total → fast=${known.length} slow=${unknown.length} deferred=${deferred.length}`,
  );

  // Fast path: webcast/room/info/ não é rate-limited, dá pra ir largo.
  const fastResults = await runPool(known, verifyWithKnownRoomId, 8, 100, 999);

  // Warm-up antes do slow path: 1 GET em www.tiktok.com/ pega ttwid/msToken
  // que reduzem flag de bot no /live scrape seguinte.
  await warmupSession();

  // Slow path: /live é Akamai-protegido. Serial (concurrency 1), gap 4000ms
  // base + jitter ±50% (= 2-6s), circuit breaker em 3 blocked consecutivos.
  const slowResults = await runPool(unknown, verifyUnknown, 1, 4000, 3);

  const deferredResults = deferred.map((c) => ({ handle: c.handle, outcome: "deferred" }));
  return [...fastResults, ...slowResults, ...deferredResults];
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      if (total > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks).toString("utf8");
        resolve(buf ? JSON.parse(buf) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(req, res, 200, { ok: true, version: VERSION, node: process.version });
    return;
  }

  if (req.method === "POST" && url.pathname === "/verify") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(req, res, 400, { error: "invalid body", message: String(err) });
      return;
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    if (candidates.length === 0) {
      sendJson(req, res, 200, {
        lives: [],
        roomIdHints: [],
        stats: {
          total: 0,
          live: 0,
          error: 0,
          offline: 0,
          noCommerce: 0,
          blocked: 0,
          deferred: 0,
          skipped: 0,
          staleCache: 0,
        },
      });
      return;
    }

    const t0 = Date.now();
    const results = await verifyBatch(candidates);
    const lives = results.filter((r) => r.outcome === "live").map((r) => r.live);

    // Hints: todo roomId descoberto (inclui no-commerce) vira cache pro próximo
    // run, mesmo quando não foi live-válida. Economiza /live scrape.
    const roomIdHints = results
      .filter((r) => (r.outcome === "live" || r.outcome === "no-commerce") && r.roomId)
      .map((r) => ({ handle: r.handle, roomId: r.outcome === "live" ? r.live.roomId : r.roomId }))
      .filter((r) => r.roomId);
    // Live também alimenta hints
    for (const l of lives) {
      if (!roomIdHints.find((h) => h.handle === l.hostHandle)) {
        roomIdHints.push({ handle: l.hostHandle, roomId: l.roomId });
      }
    }

    const stats = {
      total: results.length,
      live: lives.length,
      error: results.filter((r) => r.outcome === "error").length,
      offline: results.filter((r) => r.outcome === "offline").length,
      noCommerce: results.filter((r) => r.outcome === "no-commerce").length,
      blocked: results.filter((r) => r.outcome === "blocked").length,
      deferred: results.filter((r) => r.outcome === "deferred").length,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      staleCache: results.filter((r) => r.outcome === "stale-cache").length,
      elapsedMs: Date.now() - t0,
    };
    console.log(
      `[verify] ${stats.total} → live=${stats.live} offline=${stats.offline} nc=${stats.noCommerce} err=${stats.error} blk=${stats.blocked} def=${stats.deferred} skp=${stats.skipped} stale=${stats.staleCache} in ${stats.elapsedMs}ms`,
    );
    sendJson(req, res, 200, { lives, roomIdHints, stats });
    return;
  }

  sendJson(req, res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`TikTok verify daemon v${VERSION} running at http://${HOST}:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /verify   { candidates: [{handle, nickname?, avatarUrl?, roomId?}] }`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close(() => process.exit(0));
});
