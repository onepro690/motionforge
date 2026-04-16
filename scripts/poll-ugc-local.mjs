// Local manual poll — bypass Vercel cron auth, run Vertex poll + assemble
// directly using prod DB/creds. Usado pra destravar videos presos em
// GENERATING_TAKES.

import dotenv from "dotenv";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { GoogleAuth } from "google-auth-library";
import { put } from "@vercel/blob";

dotenv.config({ path: path.join(process.cwd(), ".env.production.local") });

const PROJECT_ID = "gen-lang-client-0466084510";
const prisma = new PrismaClient();

// Fix raw newlines inside JSON string literals (dotenv unescapes \n into
// real newlines, which JSON.parse rejects).
function repairJson(raw) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = !inString;
      continue;
    }
    if (inString && ch === "\n") {
      out += "\\n";
      continue;
    }
    if (inString && ch === "\r") {
      out += "\\r";
      continue;
    }
    out += ch;
  }
  return out;
}

async function getAccessToken() {
  const credentials = JSON.parse(repairJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tok = await client.getAccessToken();
  return tok.token;
}

async function pollOne(videoId, accessToken) {
  const video = await prisma.ugcGeneratedVideo.findUnique({
    where: { id: videoId },
    include: { takes: true },
  });
  if (!video || video.status !== "GENERATING_TAKES") {
    console.log(`  skip ${videoId}: status=${video?.status}`);
    return;
  }

  let allCompleted = true;
  let failedCount = 0;

  for (const take of video.takes) {
    if (take.status === "COMPLETED") continue;
    if (take.status === "FAILED") {
      failedCount++;
      continue;
    }
    if (!take.veoJobId) {
      allCompleted = false;
      continue;
    }

    const job = await prisma.generationJob.findUnique({ where: { id: take.veoJobId } });
    if (!job?.externalTaskId) {
      allCompleted = false;
      continue;
    }

    const opName = job.externalTaskId;
    const m = opName.match(/publishers\/google\/models\/([^/]+)\//);
    const modelId = m?.[1] ?? "veo-3.0-fast-generate-001";
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/${modelId}:fetchPredictOperation`;

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: opName }),
    });
    const data = await r.json();
    console.log(`  take ${take.takeIndex} done=${data.done} err=${data.error?.message ?? ""}`);

    if (!data.done) {
      allCompleted = false;
      continue;
    }
    if (data.error) {
      await prisma.generationJob.update({
        where: { id: job.id },
        data: { status: "FAILED", errorMessage: data.error.message },
      });
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "FAILED", errorMessage: data.error.message },
      });
      failedCount++;
      continue;
    }

    const videoEntry = data.response?.videos?.[0];
    const rawBase64 = videoEntry?.bytesBase64Encoded;
    const rawUri = videoEntry?.uri;

    let videoUrl;
    if (rawBase64) {
      const buf = Buffer.from(rawBase64, "base64");
      const blob = await put(`ugc-take-${take.id}.mp4`, buf, {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
      });
      videoUrl = blob.url;
    } else if (rawUri) {
      const withoutScheme = rawUri.startsWith("gs://") ? rawUri.slice(5) : rawUri;
      const slashIdx = withoutScheme.indexOf("/");
      const bucket = withoutScheme.slice(0, slashIdx);
      const object = encodeURIComponent(withoutScheme.slice(slashIdx + 1));
      const gcsRes = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const buf = await gcsRes.arrayBuffer();
      const blob = await put(`ugc-take-${take.id}.mp4`, Buffer.from(buf), {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
      });
      videoUrl = blob.url;
    } else {
      await prisma.ugcGeneratedTake.update({
        where: { id: take.id },
        data: { status: "FAILED", errorMessage: "No video returned" },
      });
      failedCount++;
      continue;
    }

    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", outputVideoUrl: videoUrl, completedAt: new Date() },
    });
    await prisma.ugcGeneratedTake.update({
      where: { id: take.id },
      data: { status: "COMPLETED", videoUrl },
    });
    console.log(`  take ${take.takeIndex} saved → ${videoUrl}`);
  }

  console.log(`  allCompleted=${allCompleted} failed=${failedCount}/${video.takes.length}`);
  return { allCompleted, failedCount, total: video.takes.length };
}

(async () => {
  const token = await getAccessToken();
  console.log("got access token", token.slice(0, 20) + "...");

  const stuck = await prisma.ugcGeneratedVideo.findMany({
    where: { status: "GENERATING_TAKES" },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  console.log(`found ${stuck.length} stuck videos`);

  for (const v of stuck) {
    console.log(`VIDEO ${v.id} (${v.createdAt.toISOString()})`);
    try {
      await pollOne(v.id, token);
    } catch (e) {
      console.error("  ERROR", e.message);
    }
  }

  await prisma.$disconnect();
})();
