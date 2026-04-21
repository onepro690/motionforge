#!/usr/bin/env node
// TikTok Live Verification Daemon — roda na máquina do usuário com IP
// residencial pra verificar lives sem WAF bloquear (o que acontece nos IPs
// Vercel). Expõe HTTP em 127.0.0.1:3333 pra o front chamar via CORS.

import http from "node:http";

const PORT = 3333;
const HOST = "127.0.0.1";
const VERSION = "1.0.0";

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
];
const randomUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// Escape do handle pra uso em RegExp — handles podem ter ".", "_", "-"
// (caracteres que em regex são literais, mas por segurança escapa tudo).
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

// Resolve handle → roomId via HTML scraping da página /@handle/live.
// O endpoint webcast/room/info_by_scope/ está morto (retorna 10013 "Url does
// not match" pra qualquer handle). A página pública /live tem JSON inline
// com roomId + status embutido. Só detecta SE está live; commerce vem do
// segundo call (webcast/room/info/).
async function fetchRoomByHandle(handle) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}/live`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { error: true };
    const html = await res.text();
    if (!html || html.length < 10_000) return { error: true };

    // Procura o bloco inline do DONO da página: "uniqueId":"<handle>" seguido
    // de "roomId":"<id>" na janela próxima. Evita pegar roomId de creators
    // recomendados que podem aparecer no HTML. Quando offline, roomId = "".
    //
    // Regex: procura uniqueId do handle específico (case-insensitive pq
    // às vezes o TikTok normaliza) e captura roomId até 400 chars depois.
    const handleEsc = candidateHandleToRegex(handle);
    const anchorRe = new RegExp(
      `"uniqueId"\\s*:\\s*"${handleEsc}"[\\s\\S]{0,400}?"roomId"\\s*:\\s*"(\\d{15,}|)"`,
      "i",
    );
    const anchorMatch = html.match(anchorRe);
    let roomId = null;
    if (anchorMatch) {
      roomId = anchorMatch[1] || null; // pode ser "" → null → offline
    } else {
      // Fallback: primeira ocorrência de roomId não-vazio. Menos preciso
      // mas cobre quando o ordering dos campos inverte.
      const firstNonEmpty = html.match(/"roomId"\s*:\s*"(\d{15,})"/);
      if (firstNonEmpty) roomId = firstNonEmpty[1];
      else if (/"roomId"\s*:\s*""/.test(html)) roomId = null;
      else return { error: true };
    }

    if (!roomId) return { isLive: false };

    // Status embutido (2 = live). Fallback: se achou roomId numérico,
    // assume live (TikTok só popula roomId quando stream ativa).
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

async function verifyCandidate(candidate) {
  // Se veio com roomId já conhecido, pula a resolução e vai direto pro info.
  let roomId = candidate.roomId && /^\d{15,}$/.test(candidate.roomId) ? candidate.roomId : null;

  if (!roomId) {
    const byHandle = await fetchRoomByHandle(candidate.handle);
    if (byHandle.error) return { handle: candidate.handle, outcome: "error" };
    if (!byHandle.isLive) return { handle: candidate.handle, outcome: "offline" };
    roomId = byHandle.roomId;
  }

  const full = await fetchFullRoomInfo(roomId);
  if (!full) return { handle: candidate.handle, outcome: "error" };
  if (full.status !== 2) return { handle: candidate.handle, outcome: "offline" };
  if (!full.hasCommerce) return { handle: candidate.handle, outcome: "no-commerce" };

  return {
    handle: candidate.handle,
    outcome: "live",
    live: {
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
    },
  };
}

async function verifyBatch(candidates, concurrency = 5, gapMs = 150) {
  const results = [];
  const queue = [...candidates];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) break;
      const r = await verifyCandidate(c);
      results.push(r);
      if (gapMs > 0) await new Promise((res) => setTimeout(res, gapMs));
    }
  });
  await Promise.all(workers);
  return results;
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
      if (total > 2 * 1024 * 1024) {
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
      sendJson(req, res, 200, { lives: [], stats: { total: 0, live: 0, error: 0, offline: 0, noCommerce: 0 } });
      return;
    }
    const concurrency = Math.min(Math.max(1, Number(body.concurrency) || 5), 10);
    const gapMs = Math.min(Math.max(0, Number(body.gapMs) || 150), 2000);

    const t0 = Date.now();
    const results = await verifyBatch(candidates, concurrency, gapMs);
    const lives = results.filter((r) => r.outcome === "live").map((r) => r.live);
    const stats = {
      total: results.length,
      live: lives.length,
      error: results.filter((r) => r.outcome === "error").length,
      offline: results.filter((r) => r.outcome === "offline").length,
      noCommerce: results.filter((r) => r.outcome === "no-commerce").length,
      elapsedMs: Date.now() - t0,
    };
    console.log(
      `[verify] ${stats.total} → live=${stats.live} offline=${stats.offline} no-commerce=${stats.noCommerce} error=${stats.error} in ${stats.elapsedMs}ms`,
    );
    sendJson(req, res, 200, { lives, stats });
    return;
  }

  sendJson(req, res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`TikTok verify daemon running at http://${HOST}:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /verify   { candidates: [{handle, nickname?, avatarUrl?, roomId?}], concurrency?, gapMs? }`);
  console.log(`Allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close(() => process.exit(0));
});
