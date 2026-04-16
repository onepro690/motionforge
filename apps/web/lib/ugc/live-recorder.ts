// Shared helpers para gravação chunked de lives (usado por record-now e cron).
//
// recordChunk: grava 1 chunk da live no Blob, atualiza DB, retorna stillLive.
// finalizeRecording: concat todos os chunks num mp4 final + DONE.

import { prisma } from "@motion/database";
import { fetchHlsUrl, isLiveActive } from "@/lib/ugc/live-scraper";
import { put, list, del } from "@vercel/blob";
import { spawn } from "child_process";
import { mkdir, readFile, writeFile, unlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const FFMPEG = ffmpegInstaller.path;

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

export interface ChunkResult {
  ok: true;
  chunkUrl: string;
  chunkSeconds: number;
  cumulativeSeconds: number;
  stillLive: boolean;
}

export interface ChunkError {
  ok: false;
  error: string;
  message: string;
  stillLive: boolean;
}

export async function recordChunk(
  id: string,
  durationSeconds = 200,
): Promise<ChunkResult | ChunkError> {
  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live) return { ok: false, error: "not_found", message: "session", stillLive: false };

  // Cap em 220s: precisa caber ffmpeg + upload blob + DB updates dentro dos
  // 300s de maxDuration da serverless. 240s dava timeout em borderline cases.
  const requested = Math.max(10, Math.min(durationSeconds, 220));

  // Tenta refresh da HLS até 3x. TikTok WAF às vezes bloqueia; um retry
  // rapidinho costuma passar. Se tudo falhar, cai na URL persistida.
  let hlsUrl = live.hlsUrl;
  let flvUrl = live.flvUrl;
  if (live.roomId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await fetchHlsUrl(live.roomId);
      if (fresh.hlsUrl || fresh.flvUrl) {
        if (fresh.hlsUrl) hlsUrl = fresh.hlsUrl;
        if (fresh.flvUrl) flvUrl = fresh.flvUrl;
        break;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  const streamUrl = hlsUrl || flvUrl;
  if (!streamUrl) {
    // Sem stream — nunca marca FAILED. Mantém RECORDING com error msg;
    // finalize decide se vai virar DONE (com chunks) ou FAILED (sem chunks).
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "RECORDING",
        recordingError: "no_stream_url",
        recordingLockedUntil: null,
      },
    });
    return {
      ok: false,
      error: "no_stream_url",
      message: "Live sem stream no momento. Tentando novamente…",
      stillLive: false,
    };
  }

  // Lock + RECORDING. Expira em ~280s (pouco mais que chunk+overhead).
  await prisma.liveSession.update({
    where: { id },
    data: {
      recordingStatus: "RECORDING",
      recordingStartedAt: live.recordingStartedAt ?? new Date(),
      recordingError: null,
      recordingLockedUntil: new Date(Date.now() + 280_000),
      hlsUrl,
      flvUrl,
    },
  });

  const workDir = join(tmpdir(), `live-chunk-${randomBytes(6).toString("hex")}`);
  await mkdir(workDir, { recursive: true });
  const outPath = join(workDir, "chunk.mp4");

  try {
    await runFfmpeg([
      "-y",
      "-loglevel", "error",
      "-t", String(requested),
      "-i", streamUrl,
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart",
      outPath,
    ]);

    const buf = await readFile(outPath);
    const chunkKey = `ugc/lives/${id}/chunks/${Date.now()}.mp4`;
    const blob = await put(chunkKey, buf, {
      access: "public",
      contentType: "video/mp4",
      allowOverwrite: true,
    });

    const cumulative = (live.recordingDurationSeconds ?? 0) + requested;
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "RECORDING",
        recordingDurationSeconds: cumulative,
        recordingLockedUntil: null,
      },
    });

    const stillLive = live.roomId ? await isLiveActive(live.roomId) : false;

    return {
      ok: true,
      chunkUrl: blob.url,
      chunkSeconds: requested,
      cumulativeSeconds: cumulative,
      stillLive,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // NUNCA marca FAILED aqui — erro de chunk é quase sempre transiente
    // (SIGTERM no refresh, WAF piscando, HLS trocando). Mantém RECORDING,
    // limpa lock, cron ou cliente retentam. Só marca FAILED de verdade
    // quando finalize não encontra nenhum chunk válido.
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "RECORDING",
        recordingError: message.slice(0, 500),
        recordingLockedUntil: null,
      },
    });
    const stillLive = live.roomId ? await isLiveActive(live.roomId).catch(() => false) : false;
    return { ok: false, error: "chunk_failed", message, stillLive };
  } finally {
    await unlink(outPath).catch(() => {});
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function finalizeRecording(id: string) {
  const prefix = `ugc/lives/${id}/chunks/`;
  const listing = await list({ prefix });
  const chunks = [...listing.blobs].sort(
    (a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime(),
  );

  if (chunks.length === 0) {
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "FAILED",
        recordingError: "no_chunks",
        recordingEndedAt: new Date(),
        recordingLockedUntil: null,
      },
    });
    return { ok: false as const, error: "no_chunks" };
  }

  if (chunks.length === 1) {
    const finalKey = `ugc/lives/${id}/final.mp4`;
    const resp = await fetch(chunks[0].url);
    const buf = Buffer.from(await resp.arrayBuffer());
    const finalBlob = await put(finalKey, buf, {
      access: "public",
      contentType: "video/mp4",
      allowOverwrite: true,
    });
    await del(chunks[0].url).catch(() => null);
    const updated = await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "DONE",
        recordingUrl: finalBlob.url,
        recordingEndedAt: new Date(),
        recordingError: null,
        recordingLockedUntil: null,
      },
    });
    return { ok: true as const, finalUrl: finalBlob.url, chunks: 1, updated };
  }

  const workDir = join(tmpdir(), `live-final-${randomBytes(6).toString("hex")}`);
  await mkdir(workDir, { recursive: true });

  try {
    const localPaths: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const resp = await fetch(chunks[i].url);
      const buf = Buffer.from(await resp.arrayBuffer());
      const p = join(workDir, `chunk-${i.toString().padStart(4, "0")}.mp4`);
      await writeFile(p, buf);
      localPaths.push(p);
    }

    const listPath = join(workDir, "list.txt");
    const listContent = localPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listContent);

    const finalLocal = join(workDir, "final.mp4");
    await runFfmpeg([
      "-y",
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      finalLocal,
    ]);

    const finalBuf = await readFile(finalLocal);
    const finalKey = `ugc/lives/${id}/final.mp4`;
    const finalBlob = await put(finalKey, finalBuf, {
      access: "public",
      contentType: "video/mp4",
      allowOverwrite: true,
    });

    for (const c of chunks) {
      await del(c.url).catch(() => null);
    }

    const updated = await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "DONE",
        recordingUrl: finalBlob.url,
        recordingEndedAt: new Date(),
        recordingError: null,
        recordingLockedUntil: null,
      },
    });

    return { ok: true as const, finalUrl: finalBlob.url, chunks: chunks.length, updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "FAILED",
        recordingError: `finalize: ${message.slice(0, 480)}`,
        recordingEndedAt: new Date(),
        recordingLockedUntil: null,
      },
    });
    return { ok: false as const, error: "finalize_failed", message };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
