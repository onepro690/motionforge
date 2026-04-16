/**
 * TikTok Shop Live Recorder
 * Roda localmente — monitora o DB e grava lives marcadas como QUEUED.
 *
 * Como usar:
 *   cd apps/worker
 *   npx ts-node src/live-recorder.ts
 *
 * O script fica em loop, checa a cada 15s por novas gravações na fila,
 * grava via ffmpeg e sobe para o Vercel Blob.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { put } from "@vercel/blob";
import { PrismaClient } from "@prisma/client";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();

// ffmpeg binário via @ffmpeg-installer
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = require("@ffmpeg-installer/ffmpeg").path;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// Duração máxima de gravação por live (em segundos). Padrão: 2 horas.
const MAX_RECORD_SECONDS = parseInt(process.env.MAX_LIVE_RECORD_SECONDS ?? "7200", 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[live-recorder] ${new Date().toISOString()} ${msg}`);
}

async function notifyStatus(
  sessionId: string,
  status: string,
  extra: { recordingUrl?: string; recordingError?: string } = {}
) {
  try {
    await fetch(`${APP_URL}/api/ugc/lives/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Usa a BETTER_AUTH_SECRET como bearer simples para autenticação interna
      body: JSON.stringify({ recordingStatus: status, ...extra }),
    });
  } catch (e) {
    log(`Failed to notify status for ${sessionId}: ${e}`);
  }
}

// ── Gravação de uma live ──────────────────────────────────────────────────────

async function recordLive(session: {
  id: string;
  roomId: string;
  title: string | null;
  hostHandle: string | null;
  hlsUrl: string | null;
  flvUrl: string | null;
}) {
  const streamUrl = session.hlsUrl || session.flvUrl;
  if (!streamUrl) {
    log(`Session ${session.id}: no stream URL, skipping`);
    await prisma.liveSession.update({
      where: { id: session.id },
      data: { recordingStatus: "FAILED", recordingError: "No stream URL available", recordingEndedAt: new Date() },
    });
    return;
  }

  const handle   = session.hostHandle ?? session.roomId;
  const tmpFile  = path.join(os.tmpdir(), `tiktok_live_${session.roomId}_${Date.now()}.mp4`);

  log(`Recording @${handle} → ${tmpFile} (max ${MAX_RECORD_SECONDS}s)`);
  log(`Stream URL: ${streamUrl.slice(0, 80)}...`);

  // Atualiza status para RECORDING
  await prisma.liveSession.update({
    where: { id: session.id },
    data: { recordingStatus: "RECORDING", recordingStartedAt: new Date() },
  });
  await notifyStatus(session.id, "RECORDING");

  const startTime = Date.now();

  try {
    // Grava com ffmpeg — para quando: (a) live encerra, (b) atingiu MAX_RECORD_SECONDS
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i", streamUrl,
      "-t", String(MAX_RECORD_SECONDS),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", "128k",
      tmpFile,
    ], { timeout: (MAX_RECORD_SECONDS + 120) * 1000 });
  } catch (err: unknown) {
    // ffmpeg pode retornar exit code não-zero quando a live encerra (EOF do HLS)
    // Se o arquivo existe e tem tamanho > 1MB, consideramos sucesso
    const stat = fs.existsSync(tmpFile) ? fs.statSync(tmpFile) : null;
    if (!stat || stat.size < 1_000_000) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Recording FAILED for @${handle}: ${msg.slice(0, 200)}`);
      await prisma.liveSession.update({
        where: { id: session.id },
        data: { recordingStatus: "FAILED", recordingError: msg.slice(0, 500), recordingEndedAt: new Date() },
      });
      await notifyStatus(session.id, "FAILED", { recordingError: msg.slice(0, 200) });
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      return;
    }
    log(`ffmpeg exited with error but file OK (${Math.round(stat.size / 1_000_000)}MB) — treating as success`);
  }

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);
  const stat = fs.existsSync(tmpFile) ? fs.statSync(tmpFile) : null;

  if (!stat || stat.size < 100_000) {
    log(`Recording too small for @${handle}, skipping upload`);
    await prisma.liveSession.update({
      where: { id: session.id },
      data: { recordingStatus: "FAILED", recordingError: "Recording too small or empty", recordingEndedAt: new Date() },
    });
    return;
  }

  log(`Uploading ${Math.round(stat.size / 1_000_000)}MB for @${handle}...`);

  try {
    const fileBuffer = fs.readFileSync(tmpFile);
    const blob = await put(
      `live-recordings/${handle}_${session.roomId}_${Date.now()}.mp4`,
      fileBuffer,
      { access: "public", contentType: "video/mp4" }
    );

    log(`Uploaded to Blob: ${blob.url}`);

    await prisma.liveSession.update({
      where: { id: session.id },
      data: {
        recordingStatus: "DONE",
        recordingUrl: blob.url,
        recordingEndedAt: new Date(),
        recordingDurationSeconds: durationSeconds,
        isLive: false,
      },
    });
    await notifyStatus(session.id, "DONE", { recordingUrl: blob.url });
  } catch (uploadErr) {
    const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
    log(`Upload FAILED for @${handle}: ${msg}`);
    await prisma.liveSession.update({
      where: { id: session.id },
      data: { recordingStatus: "FAILED", recordingError: `Upload failed: ${msg}`.slice(0, 500), recordingEndedAt: new Date() },
    });
  } finally {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
      log(`Temp file deleted: ${tmpFile}`);
    }
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────

const recording = new Set<string>(); // IDs sendo gravados agora

async function tick() {
  const queued = await prisma.liveSession.findMany({
    where: {
      recordingStatus: "QUEUED",
      id: { notIn: [...recording] },
    },
    orderBy: { viewerCount: "desc" },
    take: 3, // máximo 3 gravações simultâneas
  });

  for (const session of queued) {
    recording.add(session.id);
    log(`Starting recording for @${session.hostHandle} (${session.id})`);

    // Grava em background — não bloqueia o loop
    recordLive(session).finally(() => {
      recording.delete(session.id);
    });
  }

  if (recording.size > 0) {
    log(`Active recordings: ${recording.size}`);
  }
}

async function main() {
  log("Live Recorder started");
  log(`App URL: ${APP_URL}`);
  log(`ffmpeg: ${ffmpegPath}`);
  log(`Max duration: ${MAX_RECORD_SECONDS}s`);
  log("Waiting for QUEUED recordings...\n");

  // Executa imediatamente e depois a cada 15s
  await tick();
  setInterval(tick, 15_000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
