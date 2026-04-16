/**
 * MotionForge — YouTube Local Server
 * Roda na máquina do usuário para executar yt-dlp localmente.
 * Inicie com: npm run yt (na raiz do projeto)
 */

import http from "http";
import { spawn } from "child_process";
import { createReadStream } from "fs";
import { mkdir, stat, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const PORT = 7842;

// Origens permitidas (localhost dev + Vercel prod)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://motion-transfer-saas.vercel.app",
];

function setCORS(req, res) {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function isValidYouTubeUrl(url) {
  try {
    const { hostname } = new URL(url);
    return ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(hostname);
  } catch {
    return false;
  }
}

function ytDlpInfo(videoUrl) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("yt-dlp", [
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      videoUrl,
    ]);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Resposta inválida do yt-dlp"));
        }
      } else {
        reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp não encontrado. Instale: pip install yt-dlp"));
      } else {
        reject(err);
      }
    });
  });
}

function ytDlpDownload(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    let stderr = "";

    const proc = spawn("yt-dlp", [
      videoUrl,
      "-f",
      "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "-o",
      outputPath,
    ]);

    // Mostra progresso no terminal
    proc.stdout.on("data", (d) => process.stdout.write(d));
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp não encontrado. Instale: pip install yt-dlp"));
      } else {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── GET /health ──────────────────────────────────────────────
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "1.0.0" }));
    return;
  }

  // ── POST /info ───────────────────────────────────────────────
  if (url.pathname === "/info" && req.method === "POST") {
    const { url: videoUrl } = await readBody(req);

    if (!videoUrl || !isValidYouTubeUrl(videoUrl)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "URL inválida" }));
      return;
    }

    console.log(`\n🔍 Buscando info: ${videoUrl}`);

    try {
      const info = await ytDlpInfo(videoUrl);
      console.log(`✅ Encontrado: ${info.title}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          title: info.title,
          duration: info.duration,
          thumbnail: info.thumbnail,
          channel: info.channel ?? info.uploader,
        })
      );
    } catch (err) {
      console.error("❌ Erro ao buscar info:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /download ───────────────────────────────────────────
  if (url.pathname === "/download" && req.method === "POST") {
    const { url: videoUrl, title } = await readBody(req);

    if (!videoUrl || !isValidYouTubeUrl(videoUrl)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "URL inválida" }));
      return;
    }

    const id = randomUUID();
    const tmpDir = join(tmpdir(), `yt-${id}`);
    const outputPath = join(tmpDir, "video.mp4");

    console.log(`\n⬇️  Baixando: ${title ?? videoUrl}`);

    try {
      await mkdir(tmpDir, { recursive: true });
      await ytDlpDownload(videoUrl, outputPath);

      const fileStats = await stat(outputPath);
      const safeName =
        (title ?? "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) + ".mp4";

      console.log(
        `✅ Download pronto: ${safeName} (${(fileStats.size / 1024 / 1024).toFixed(1)} MB)`
      );

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fileStats.size.toString(),
        "Content-Disposition": `attachment; filename="${safeName}"`,
      });

      const fileStream = createReadStream(outputPath);
      fileStream.pipe(res);

      const cleanup = () =>
        rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      fileStream.on("end", cleanup);
      fileStream.on("error", cleanup);
      res.on("close", cleanup);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      console.error("❌ Erro no download:", err.message);

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  MotionForge — YouTube Local Server        ║");
  console.log(`║  Rodando em http://localhost:${PORT}         ║`);
  console.log("║  Deixe este terminal aberto.               ║");
  console.log("╚════════════════════════════════════════════╝\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Porta ${PORT} já está em uso. Servidor já está rodando.`);
  } else {
    console.error("❌ Erro no servidor:", err.message);
  }
  process.exit(1);
});
