import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, readdir } from "fs/promises";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const execFileP = promisify(execFile);

export const maxDuration = 30;

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function listDir(p: string, maxItems = 50): Promise<string[] | string> {
  try {
    const entries = await readdir(p);
    return entries.slice(0, maxItems);
  } catch (err) {
    return `[error: ${(err as Error).message}]`;
  }
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ffmpegPath = ffmpegInstaller.path;

  // 1. ffmpeg version + features
  let version = "";
  let filtersOut = "";
  let configuration = "";
  try {
    const { stdout } = await execFileP(ffmpegPath, ["-hide_banner", "-version"], { maxBuffer: 5 * 1024 * 1024 });
    version = stdout.split("\n").slice(0, 4).join("\n");
    const m = stdout.match(/configuration:[^\n]+/);
    configuration = m ? m[0] : "(no config line)";
  } catch (err) {
    version = `ERROR: ${(err as Error).message}`;
  }
  try {
    const { stdout } = await execFileP(ffmpegPath, ["-hide_banner", "-filters"], { maxBuffer: 5 * 1024 * 1024 });
    filtersOut = stdout;
  } catch (err) {
    filtersOut = `ERROR: ${(err as Error).message}`;
  }

  const hasSubtitles = /\bsubtitles\b/i.test(filtersOut);
  const hasDrawtext = /\bdrawtext\b/i.test(filtersOut);
  const hasAss = /\bass\b/i.test(filtersOut);

  // 2. Font candidates check
  const fontCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
    "/var/task/apps/web/public/fonts/Anton-Regular.ttf",
    "/var/task/public/fonts/Anton-Regular.ttf",
  ];
  const fontsExist: Record<string, boolean> = {};
  for (const p of fontCandidates) {
    fontsExist[p] = await pathExists(p);
  }

  // 3. Listings
  const fontsRoot = await listDir("/usr/share/fonts");
  const cwdListing = await listDir(process.cwd());
  const publicFontsListing = await listDir(`${process.cwd()}/public/fonts`).catch(() => "(no public/fonts)");
  const taskFontsListing = await listDir("/var/task/apps/web/public/fonts").catch(() => "(no /var/task path)");

  // 4. fontfiles config
  let fcList = "";
  try {
    const { stdout } = await execFileP("fc-list", [], { maxBuffer: 5 * 1024 * 1024, timeout: 10_000 });
    fcList = stdout.split("\n").slice(0, 30).join("\n");
  } catch (err) {
    fcList = `fc-list unavailable: ${(err as Error).message}`;
  }

  return NextResponse.json({
    cwd: process.cwd(),
    ffmpeg: {
      path: ffmpegPath,
      version,
      configurationLine: configuration,
      hasSubtitlesFilter: hasSubtitles,
      hasAssFilter: hasAss,
      hasDrawtextFilter: hasDrawtext,
    },
    fonts: {
      candidatesExist: fontsExist,
      fontsRoot,
      publicFontsListing,
      taskFontsListing,
      fcList,
    },
    cwdListingPreview: Array.isArray(cwdListing) ? cwdListing.slice(0, 30) : cwdListing,
  });
}
