import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir, rmdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { execFile } from "child_process";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300;
export const runtime = "nodejs";

interface Cut {
  start: number;
  end: number;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    const proc = execFile(ffmpegInstaller.path, ["-i", videoPath, "-f", "null", "-"], { timeout: 15000 });
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const centis = parseInt(match[4]);
        resolve(hours * 3600 + minutes * 60 + seconds + centis / 100);
      } else {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

// Merge overlapping/adjacent cuts, clamped to [0, total].
function normalizeCuts(cuts: Cut[], total: number): Cut[] {
  const clean = cuts
    .map(c => ({ start: Math.max(0, Math.min(total, c.start)), end: Math.max(0, Math.min(total, c.end)) }))
    .filter(c => c.end - c.start > 0.05)
    .sort((a, b) => a.start - b.start);

  const merged: Cut[] = [];
  for (const c of clean) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.05) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

// Invert cuts into keep-segments.
function keepSegments(cuts: Cut[], total: number): Cut[] {
  const keeps: Cut[] = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < total - 0.05) keeps.push({ start: cursor, end: total });
  return keeps;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id },
    select: { id: true, userId: true, finalVideoUrl: true },
  });
  if (!video || video.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!video.finalVideoUrl) {
    return NextResponse.json({ error: "Vídeo final não disponível" }, { status: 400 });
  }

  const body = await request.json();
  const rawCuts: Cut[] = Array.isArray(body?.cuts) ? body.cuts : [];
  if (rawCuts.length === 0) {
    return NextResponse.json({ error: "Nenhum corte informado" }, { status: 400 });
  }

  const tmpId = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `ugc-trim-${tmpId}`);
  await mkdir(tmpDir, { recursive: true });
  const tempFiles: string[] = [];

  try {
    const sourcePath = join(tmpDir, "source.mp4");
    await downloadFile(video.finalVideoUrl, sourcePath);
    tempFiles.push(sourcePath);

    const total = await getVideoDuration(sourcePath);
    if (total <= 0) {
      return NextResponse.json({ error: "Não foi possível ler a duração do vídeo" }, { status: 500 });
    }

    const cuts = normalizeCuts(rawCuts, total);
    const keeps = keepSegments(cuts, total);

    if (keeps.length === 0) {
      return NextResponse.json({ error: "Os cortes removem o vídeo inteiro" }, { status: 400 });
    }

    // Extract each keep segment.
    const parts: string[] = [];
    for (let i = 0; i < keeps.length; i++) {
      const seg = keeps[i];
      const duration = seg.end - seg.start;
      if (duration < 0.1) continue;

      const partPath = join(tmpDir, `part-${i}.mp4`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(sourcePath)
          .seekInput(seg.start)
          .duration(duration)
          .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
          .output(partPath)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });
      parts.push(partPath);
      tempFiles.push(partPath);
    }

    if (parts.length === 0) {
      return NextResponse.json({ error: "Nenhum segmento válido após o corte" }, { status: 400 });
    }

    let finalPath: string;
    if (parts.length === 1) {
      finalPath = parts[0];
    } else {
      const listPath = join(tmpDir, "list.txt");
      const listContent = parts.map(p => `file '${p}'`).join("\n");
      await writeFile(listPath, listContent, "utf8");
      tempFiles.push(listPath);

      const concatPath = join(tmpDir, "concat.mp4");
      tempFiles.push(concatPath);

      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
          .output(concatPath)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });
      finalPath = concatPath;
    }

    const durationSeconds = await getVideoDuration(finalPath);
    const videoBuffer = await readFile(finalPath);

    const blob = await put(`ugc-trimmed-${id}.mp4`, videoBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    await prisma.ugcGeneratedVideo.update({
      where: { id },
      data: {
        finalVideoUrl: blob.url,
        durationSeconds,
        status: "AWAITING_REVIEW",
      },
    });

    return NextResponse.json({
      finalVideoUrl: blob.url,
      durationSeconds,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[trim] Error:", msg);
    return NextResponse.json({ error: `Erro ao cortar: ${msg}` }, { status: 500 });
  } finally {
    await Promise.all(tempFiles.map(p => unlink(p).catch(() => {})));
    await rmdir(tmpDir).catch(() => {});
  }
}
