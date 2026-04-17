import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { execFile } from "child_process";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300;
export const runtime = "nodejs";

// Each cut: { takeIndex, startTime, endTime } — segment to KEEP
// We trim each take to only the kept segments, then re-assemble
interface TrimSegment {
  takeIndex: number;
  start: number; // seconds from take start
  end: number;   // seconds from take start
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id },
    include: { takes: { orderBy: { takeIndex: "asc" } } },
  });
  if (!video || video.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const segments: TrimSegment[] = body.segments;

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return NextResponse.json({ error: "Nenhum segmento para manter" }, { status: 400 });
  }

  const tmpId = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `ugc-trim-${tmpId}`);
  await mkdir(tmpDir, { recursive: true });
  const tempFiles: string[] = [];

  try {
    // Group segments by takeIndex
    const segmentsByTake = new Map<number, TrimSegment[]>();
    for (const seg of segments) {
      if (!segmentsByTake.has(seg.takeIndex)) segmentsByTake.set(seg.takeIndex, []);
      segmentsByTake.get(seg.takeIndex)!.push(seg);
    }

    // Process each take: download, extract kept segments
    const outputParts: string[] = [];
    let partIdx = 0;

    for (const [takeIndex, takeSegments] of [...segmentsByTake.entries()].sort((a, b) => a[0] - b[0])) {
      const take = video.takes.find(t => t.takeIndex === takeIndex);
      if (!take?.videoUrl) continue;

      const takePath = join(tmpDir, `take-${takeIndex}.mp4`);
      await downloadFile(take.videoUrl, takePath);
      tempFiles.push(takePath);

      // Sort segments by start time
      const sorted = takeSegments.sort((a, b) => a.start - b.start);

      for (const seg of sorted) {
        const partPath = join(tmpDir, `part-${partIdx}.mp4`);
        const duration = seg.end - seg.start;
        if (duration < 0.1) continue;

        await new Promise<void>((resolve, reject) => {
          ffmpeg(takePath)
            .seekInput(seg.start)
            .duration(duration)
            .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
            .output(partPath)
            .on("end", () => resolve())
            .on("error", (err: Error) => reject(err))
            .run();
        });

        outputParts.push(partPath);
        tempFiles.push(partPath);
        partIdx++;
      }
    }

    if (outputParts.length === 0) {
      return NextResponse.json({ error: "Nenhum segmento para manter" }, { status: 400 });
    }

    // Concatenate all parts
    const concatPath = join(tmpDir, "concat.mp4");
    const listPath = join(tmpDir, "list.txt");
    const listContent = outputParts.map(p => `file '${p}'`).join("\n");
    await writeFile(listPath, listContent, "utf8");
    tempFiles.push(concatPath, listPath);

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

    // Mix with audio if available
    let finalPath = concatPath;
    if (video.audioUrl) {
      const audioPath = join(tmpDir, "audio.mp3");
      await downloadFile(video.audioUrl, audioPath);
      tempFiles.push(audioPath);

      const mixedPath = join(tmpDir, "final.mp4");
      tempFiles.push(mixedPath);

      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(concatPath)
          .input(audioPath)
          .outputOptions(["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-shortest"])
          .output(mixedPath)
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });
      finalPath = mixedPath;
    }

    const durationSeconds = await getVideoDuration(finalPath);
    const videoBuffer = await readFile(finalPath);

    const blob = await put(`ugc-trimmed-${id}.mp4`, videoBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    // Update the video record
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
    await import("fs/promises").then(fs => fs.rmdir(tmpDir).catch(() => {}));
  }
}
