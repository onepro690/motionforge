// Shared helpers para gravação chunked de lives (usado por record-now e cron).
//
// recordChunk: grava 1 chunk da live no Blob, atualiza DB, retorna stillLive.
// finalizeRecording: concat todos os chunks num mp4 final + DONE.

import { prisma } from "@motion/database";
import { fetchHlsUrl, isLiveActive } from "@/lib/ugc/live-scraper";
import { put, list, del } from "@vercel/blob";
import { spawn } from "child_process";
import { Readable } from "stream";
import { mkdir, writeFile, rm, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const FFMPEG = ffmpegInstaller.path;

// Containers Fluid Compute reusam /tmp entre invocações. Se algum chunk
// crashou no passado, deixou arquivo lá. Depois de horas, /tmp enche e
// qualquer writeFile nova falha. Limpa órfãos > 5min toda vez que entra
// no recordChunk/finalize.
async function purgeTmpOrphans(): Promise<void> {
  try {
    const entries = await readdir(tmpdir());
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const name of entries) {
      if (!name.startsWith("live-chunk-") && !name.startsWith("live-final-")) continue;
      const full = join(tmpdir(), name);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

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
  await purgeTmpOrphans();
  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live) return { ok: false, error: "not_found", message: "session", stillLive: false };

  // Bail se já foi finalizada. Sem isso, um chunk atrasado (chain + cron
  // rodando em paralelo) poderia ressuscitar uma session DONE e causar
  // double-finalize (→ FAILED no_chunks porque chunks foram deletados).
  if (live.recordingStatus === "DONE" || live.recordingStatus === "FAILED") {
    return {
      ok: false,
      error: "already_finalized",
      message: `session status=${live.recordingStatus}`,
      stillLive: false,
    };
  }

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

  // Lock atômico: só adquire se ainda não estiver DONE/FAILED e ninguém
  // com lock vigente. Previne duas execuções (chain + cron, dois chains)
  // rodando chunks em paralelo no mesmo session.
  // Aceita NONE (1ª gravação), QUEUED e RECORDING — qualquer status que
  // permita começar/continuar gravando.
  const now = new Date();
  const lockAcquired = await prisma.liveSession.updateMany({
    where: {
      id,
      recordingStatus: { in: ["NONE", "QUEUED", "RECORDING"] },
      OR: [
        { recordingLockedUntil: null },
        { recordingLockedUntil: { lt: now } },
      ],
    },
    data: {
      recordingStatus: "RECORDING",
      recordingStartedAt: live.recordingStartedAt ?? now,
      recordingError: null,
      recordingLockedUntil: new Date(Date.now() + 280_000),
      hlsUrl,
      flvUrl,
    },
  });

  if (lockAcquired.count === 0) {
    // Outra execução está gravando (ou session acabou de ser finalizada).
    // stillLive=false pra que o chain não continue se for chamada chaineada.
    return {
      ok: false,
      error: "locked",
      message: "outra execução já está gravando este chunk",
      stillLive: false,
    };
  }

  // Gravação 100% em memória — ffmpeg pipe:1 direto pra Buffer, sem tocar
  // /tmp. Vercel Fluid Compute compartilha /tmp entre invocações reusadas
  // e enchia o disco com chunks órfãos, causando "No space left on device"
  // após horas de gravação. fMP4 (fragmented) é necessário pra output pipe
  // (não-seekable), e é compatível com concat demuxer do finalize.
  try {
    const proc = spawn(
      FFMPEG,
      [
        "-y",
        "-loglevel", "error",
        // Timeouts pra não travar a função se HLS morrer no meio.
        "-rw_timeout", "15000000", // 15s em microsegundos (read/write)
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "3",
        "-t", String(requested),
        "-i", streamUrl,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        // Tolerância a pacotes corrompidos durante stream instável.
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const parts: Buffer[] = [];
    let totalBytes = 0;
    proc.stdout.on("data", (d: Buffer) => {
      parts.push(d);
      totalBytes += d.length;
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    if (exitCode !== 0) {
      throw new Error(`ffmpeg exit ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const buf = Buffer.concat(parts, totalBytes);
    // Valida chunk antes de subir. Stream morrendo no começo gera só header.
    if (buf.length < 10_000) {
      throw new Error(`chunk vazio/corrompido (${buf.length} bytes)`);
    }
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
  }
}

export async function finalizeRecording(id: string) {
  await purgeTmpOrphans();
  // Idempotência: se já foi finalizada com sucesso, retorna o existente.
  // Previne double-finalize de race (chain atrasado + cron rodando junto).
  const existing = await prisma.liveSession.findUnique({
    where: { id },
    select: { recordingStatus: true, recordingUrl: true },
  });
  if (existing?.recordingStatus === "DONE" && existing.recordingUrl) {
    const updated = await prisma.liveSession.findUnique({ where: { id } });
    return {
      ok: true as const,
      finalUrl: existing.recordingUrl,
      chunks: 0,
      updated: updated!,
      idempotent: true,
    };
  }

  // Lock atômico: previne dois finalize rodando ao mesmo tempo (chain
  // após último chunk + cron no próximo tick). Compartilha o mesmo campo
  // recordingLockedUntil que o recordChunk — um segura o outro.
  const lockAcquired = await prisma.liveSession.updateMany({
    where: {
      id,
      recordingStatus: { notIn: ["DONE"] },
      OR: [
        { recordingLockedUntil: null },
        { recordingLockedUntil: { lt: new Date() } },
      ],
    },
    data: {
      recordingLockedUntil: new Date(Date.now() + 290_000),
    },
  });
  if (lockAcquired.count === 0) {
    return { ok: false as const, error: "finalize_locked" };
  }

  const prefix = `ugc/lives/${id}/chunks/`;
  const listing = await list({ prefix });
  // Filtra chunks corrompidos/vazios (< 10KB = só header mp4, sem conteúdo).
  // Sem isso, 1 chunk ruim entre 60 bons quebraria o concat inteiro.
  const allChunks = [...listing.blobs].sort(
    (a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime(),
  );
  const chunks = allChunks.filter((c) => c.size >= 10_000);

  if (chunks.length === 0) {
    // Se já tem recordingUrl (finalize passado fez upload mas não atualizou
    // DB a tempo), marca DONE ao invés de FAILED.
    if (existing?.recordingUrl) {
      const updated = await prisma.liveSession.update({
        where: { id },
        data: {
          recordingStatus: "DONE",
          recordingError: null,
          recordingEndedAt: new Date(),
          recordingLockedUntil: null,
        },
      });
      return {
        ok: true as const,
        finalUrl: existing.recordingUrl,
        chunks: 0,
        updated,
        recovered: true,
      };
    }
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
    // Marca DONE ANTES de deletar chunks. Se DB falhar, chunks ficam pro
    // retry. Se deleção falhar depois, não tem problema (cron pode relimpar).
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
    await del(chunks[0].url).catch(() => null);
    // Limpa também os chunks descartados (corrompidos) que filtramos.
    for (const c of allChunks) {
      if (c.size < 10_000) await del(c.url).catch(() => null);
    }
    return { ok: true as const, finalUrl: finalBlob.url, chunks: 1, updated };
  }

  const workDir = join(tmpdir(), `live-final-${randomBytes(6).toString("hex")}`);
  await mkdir(workDir, { recursive: true });

  try {
    // Streaming end-to-end: ffmpeg lê chunks direto das URLs HTTPS (concat
    // demuxer) e escreve o MP4 final em stdout, que é consumido pelo
    // Vercel Blob put via ReadableStream. NADA toca /tmp — suporta lives
    // arbitrariamente longas (4h+ / múltiplos GB).
    //
    // Fragmented MP4 (frag_keyframe+empty_moov+default_base_moof) é
    // necessário porque +faststart requer output seekable, que pipe não é.
    // fMP4 é reprodutível em browsers e compatível com HTML5 video tag.
    const listPath = join(workDir, "list.txt");
    const listContent = chunks
      .map((c) => `file '${c.url.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(listPath, listContent);

    const finalKey = `ugc/lives/${id}/final.mp4`;
    const proc = spawn(
      FFMPEG,
      [
        "-y",
        "-loglevel", "error",
        "-protocol_whitelist", "file,http,https,tcp,tls",
        // Tolerância a chunks com erros/desalinhamento de timestamp.
        // (não usar -reconnect/-rw_timeout aqui — são opções de protocolo
        // HTTP que o ffmpeg rejeita quando input é o concat demuxer)
        "-fflags", "+genpts+discardcorrupt+igndts",
        "-err_detect", "ignore_err",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const uploadPromise = put(
      finalKey,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
      { access: "public", contentType: "video/mp4", allowOverwrite: true },
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    if (exitCode !== 0) {
      // Tenta abortar o upload parcial pra não deixar blob inválido
      try {
        const partial = await uploadPromise;
        await del(partial.url).catch(() => null);
      } catch {
        /* upload pode ter falhado junto */
      }
      throw new Error(`ffmpeg exit ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const finalBlob = await uploadPromise;

    // Marca DONE ANTES de deletar chunks. Se DB falhar, chunks ficam pro
    // retry (nossa recovery idempotente pega). Se deleção falhar, cron
    // pode limpar depois — chunks órfãos não quebram nada.
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

    // Deleta chunks válidos + filtrados (corrompidos).
    for (const c of allChunks) {
      await del(c.url).catch(() => null);
    }

    return { ok: true as const, finalUrl: finalBlob.url, chunks: chunks.length, updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fallback: se concat falhou, pelo menos salva o maior chunk como
    // gravação final. Melhor do que marcar FAILED e perder tudo que gravou.
    try {
      const largest = [...chunks].sort((a, b) => b.size - a.size)[0];
      if (largest) {
        const finalKey = `ugc/lives/${id}/final.mp4`;
        const resp = await fetch(largest.url);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const finalBlob = await put(finalKey, buf, {
            access: "public",
            contentType: "video/mp4",
            allowOverwrite: true,
          });
          const updated = await prisma.liveSession.update({
            where: { id },
            data: {
              recordingStatus: "DONE",
              recordingUrl: finalBlob.url,
              recordingEndedAt: new Date(),
              recordingError: `fallback_concat_failed: ${message.slice(0, 400)}`,
              recordingLockedUntil: null,
            },
          });
          for (const c of allChunks) await del(c.url).catch(() => null);
          return {
            ok: true as const,
            finalUrl: finalBlob.url,
            chunks: 1,
            updated,
            fallback: true,
          };
        }
      }
    } catch {
      /* fallback falhou tambem — marca FAILED abaixo */
    }
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
