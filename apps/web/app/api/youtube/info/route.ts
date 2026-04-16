import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { spawn } from "child_process";

export const maxDuration = 60;

function isValidYouTubeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(hostname);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { url } = await req.json();
  if (!url || !isValidYouTubeUrl(url)) {
    return NextResponse.json({ error: "URL inválida" }, { status: 400 });
  }

  try {
    const info = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn("yt-dlp", [
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ]);

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error("Resposta inválida do yt-dlp")); }
        } else {
          reject(new Error(stderr.trim() || `yt-dlp saiu com código ${code}`));
        }
      });

      proc.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("yt-dlp não encontrado. Instale com: pip install yt-dlp"));
        } else {
          reject(err);
        }
      });
    });

    return NextResponse.json({
      title: info.title as string,
      duration: info.duration as number,
      thumbnail: info.thumbnail as string,
      channel: (info.channel ?? info.uploader) as string,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro ao buscar informações do vídeo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
