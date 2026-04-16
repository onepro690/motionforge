import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import { GoogleAuth } from "google-auth-library";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const VERTEX_OPS_BASE = "https://us-central1-aiplatform.googleapis.com/v1";

async function getAccessToken(): Promise<string> {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  const credentials = JSON.parse(json) as object;
  const authClient = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await authClient.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to obtain access token");
  return token.token;
}

// Strip audio track from an MP4 buffer (fast: copies video stream, no re-encode)
async function stripAudio(videoBuffer: ArrayBuffer): Promise<Buffer> {
  const id = randomBytes(8).toString("hex");
  const inputPath  = join("/tmp", `veo3-in-${id}.mp4`);
  const outputPath = join("/tmp", `veo3-out-${id}.mp4`);
  try {
    await writeFile(inputPath, Buffer.from(videoBuffer));
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-an", "-c:v", "copy"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function hasSpeechInPrompt(generatedPrompt: string | null): boolean {
  if (!generatedPrompt) return false;
  try {
    const json = JSON.parse(generatedPrompt) as Record<string, unknown>;
    return !!(json.speech && String(json.speech).trim());
  } catch {
    return false;
  }
}

// Download a video from either a GCS URI (gs://bucket/path) or HTTPS URL
async function downloadVideo(uri: string, accessToken: string): Promise<ArrayBuffer> {
  if (uri.startsWith("gs://")) {
    // Parse gs://bucket/path/to/file and use GCS JSON API
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf("/");
    const bucket = withoutScheme.slice(0, slashIdx);
    const object = encodeURIComponent(withoutScheme.slice(slashIdx + 1));
    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`;
    const res = await fetch(gcsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`GCS download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  // Regular HTTPS URL (may need API key or auth)
  const url = uri.includes("?")
    ? `${uri}&key=${process.env.GOOGLE_AI_API_KEY ?? ""}`
    : `${uri}?key=${process.env.GOOGLE_AI_API_KEY ?? ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Video download failed: ${res.status}`);
  return res.arrayBuffer();
}

interface VertexOperation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: {
    "@type"?: string;
    // fetchPredictOperation format (Veo 3)
    videos?: Array<{ uri?: string; encoding?: string; bytesBase64Encoded?: string }>;
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
    // legacy nested formats
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
      videos?: Array<{ uri?: string }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
    generatedSamples?: Array<{ video?: { uri?: string } }>;
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const job = await prisma.generationJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (job.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (job.status === "COMPLETED" || job.status === "FAILED") {
      return NextResponse.json({ id: job.id, status: job.status, outputVideoUrl: job.outputVideoUrl, errorMessage: job.errorMessage });
    }

    if (!job.externalTaskId) {
      return NextResponse.json({ id: job.id, status: job.status, outputVideoUrl: null });
    }

    const accessToken = await getAccessToken();

    // Veo 3 on Vertex AI requires fetchPredictOperation (POST) instead of a direct GET
    // Extract model ID from the operation name: projects/.../publishers/google/models/{modelId}/operations/{opId}
    const opName = job.externalTaskId ?? "";
    const modelMatch = opName.match(/publishers\/google\/models\/([^/]+)\//);
    const modelId = modelMatch?.[1] ?? "veo-3.0-fast-generate-001";
    const fetchOpUrl = `${VERTEX_OPS_BASE}/projects/${process.env.GOOGLE_CLOUD_PROJECT ?? "gen-lang-client-0466084510"}/locations/us-central1/publishers/google/models/${modelId}:fetchPredictOperation`;

    const opRes = await fetch(fetchOpUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: opName }),
    });
    const opData = (await opRes.json()) as VertexOperation;
    console.log("[animate-veo3/[id]] fetchPredictOperation status:", opRes.status, "done:", opData.done, "error:", JSON.stringify(opData.error));

    if (!opRes.ok) {
      console.error("[animate-veo3/[id]] poll error:", JSON.stringify(opData));
      return NextResponse.json({ id: job.id, status: job.status, outputVideoUrl: null, errorMessage: JSON.stringify(opData) });
    }

    if (!opData.done) {
      if (job.status !== "PROCESSING") {
        await prisma.generationJob.update({ where: { id: job.id }, data: { status: "PROCESSING" } });
      }
      return NextResponse.json({ id: job.id, status: "PROCESSING", outputVideoUrl: null });
    }

    if (opData.error) {
      const msg = opData.error.message ?? "Veo 3 falhou";
      await prisma.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: msg, completedAt: new Date() } });
      return NextResponse.json({ id: job.id, status: "FAILED", errorMessage: msg });
    }

    // Extract video URI — Vertex AI fetchPredictOperation returns response.videos[]
    const resp = opData.response;
    const vr = resp?.generateVideoResponse ?? resp;
    const raiCount = vr?.raiMediaFilteredCount ?? 0;
    if (raiCount > 0) {
      const msg = vr?.raiMediaFilteredReasons?.[0] ?? "Vídeo bloqueado pelo filtro de segurança do Google.";
      await prisma.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: msg, completedAt: new Date() } });
      return NextResponse.json({ id: job.id, status: "FAILED", errorMessage: msg });
    }

    // Try all known response shapes — URI or inline base64
    const videoEntry = resp?.videos?.[0] ?? vr?.videos?.[0] ?? vr?.generatedSamples?.[0]?.video;
    const rawUri = videoEntry?.uri ?? null;
    const rawBase64 = (videoEntry as { bytesBase64Encoded?: string } | undefined)?.bytesBase64Encoded ?? null;

    if (!rawUri && !rawBase64) {
      const fullDump = JSON.stringify(opData);
      console.error("[animate-veo3/[id]] no video URI or base64:", fullDump);
      const msg = "Veo 3 concluiu mas não retornou vídeo";
      await prisma.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: msg, completedAt: new Date() } });
      return NextResponse.json({ id: job.id, status: "FAILED", errorMessage: msg });
    }

    // Get video buffer — from base64 inline data or download from URI
    const rawVideoBuffer: ArrayBuffer = rawBase64
      ? Buffer.from(rawBase64, "base64").buffer as ArrayBuffer
      : await downloadVideo(rawUri!, accessToken);

    // Strip audio if no speech was requested
    const videoData = hasSpeechInPrompt(job.generatedPrompt)
      ? Buffer.from(rawVideoBuffer)
      : await stripAudio(rawVideoBuffer);

    const blob = await put(`veo3-${job.id}.mp4`, videoData, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", outputVideoUrl: blob.url, completedAt: new Date() },
    });
    return NextResponse.json({ id: job.id, status: "COMPLETED", outputVideoUrl: blob.url });
  } catch (error) {
    console.error("[animate-veo3/[id]] GET error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro interno" }, { status: 500 });
  }
}
