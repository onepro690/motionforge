import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { spawn } from "child_process";
import { createReadStream } from "fs";
import { mkdir, stat, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export const maxDuration = 300;

function isValidYouTubeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(hostname);
  } catch {
    return false;
  }
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const { url, title } = await req.json();
  if (!url || !isValidYouTubeUrl(url)) {
    return new Response(JSON.stringify({ error: "URL inválida" }), { status: 400 });
  }

  const id = randomUUID();
  const tmpDir = join(tmpdir(), `yt-${id}`);
  const outputPath = join(tmpDir, "video.mp4");

  await mkdir(tmpDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("yt-dlp", [
        url,
        // best video up to 1080p + best audio → merged to mp4
        "-f",
        "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--no-warnings",
        "-o",
        outputPath,
      ]);

      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
      });

      proc.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("yt-dlp não encontrado. Instale com: pip install yt-dlp"));
        } else {
          reject(err);
        }
      });
    });

    const fileStats = await stat(outputPath);
    const fileStream = createReadStream(outputPath);

    const cleanup = () => rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    const readable = new ReadableStream({
      start(controller) {
        fileStream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        fileStream.on("end", () => { controller.close(); cleanup(); });
        fileStream.on("error", (err) => { controller.error(err); cleanup(); });
      },
      cancel() {
        fileStream.destroy();
        cleanup();
      },
    });

    const fileName = title ? `${safeName(title)}.mp4` : "video.mp4";

    return new Response(readable, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileStats.size.toString(),
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err: unknown) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : "Falha no download";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
