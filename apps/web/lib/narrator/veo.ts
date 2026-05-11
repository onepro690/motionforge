// Narrator Veo helpers: text-only Veo 3 Fast generation + polling.
// Diferente de animate-veo3 que envia uma imagem de referência, aqui é
// puramente texto → vídeo (sem image input).

import { GoogleAuth } from "google-auth-library";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const PROJECT_ID = "gen-lang-client-0466084510";
const LOCATION   = "us-central1";
const VERTEX_BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;
const VEO_MODEL_ID = "veo-3.0-fast-generate-001";

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getVertexAccessToken(): Promise<string> {
  // Cache token por 50min — mesmas creds em vários submits/polls
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.value;

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
  cachedToken = { value: token.token, expiresAt: now + 50 * 60_000 };
  return token.token;
}

export interface VeoSubmitResult {
  opName: string;
}

// Submete um Veo 3 Fast text-to-video. Aspect ratio 9:16, 8s.
export async function submitVeoTextOnly(prompt: string, accessToken?: string): Promise<VeoSubmitResult> {
  const token = accessToken ?? (await getVertexAccessToken());
  const res = await fetch(`${VERTEX_BASE}/${VEO_MODEL_ID}:predictLongRunning`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        aspectRatio: "9:16",
        durationSeconds: 8,
        sampleCount: 1,
        personGeneration: "allow_adult",
      },
    }),
  });
  const data = (await res.json()) as { name?: string; error?: { message: string } };
  if (!res.ok || !data.name) {
    throw new Error(`Veo submit failed: ${data.error?.message ?? JSON.stringify(data)}`);
  }
  return { opName: data.name };
}

export interface VeoImageInput {
  bytesBase64Encoded: string;
  mimeType: string;
}

// Extrai o último frame de um vídeo MP4 (URL pública) como JPEG 1080x1920.
// Usado pra last-frame chaining: cada take começa do frame final do anterior,
// resultando em transição visual sem corte seco.
export async function extractLastFrameAsVeoImage(videoUrl: string): Promise<VeoImageInput> {
  const id = randomBytes(8).toString("hex");
  const inPath = join("/tmp", `narrator-lastframe-in-${id}.mp4`);
  const outPath = join("/tmp", `narrator-lastframe-out-${id}.jpg`);
  try {
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Falha ao baixar take pra extrair last frame: ${res.status}`);
    await writeFile(inPath, Buffer.from(await res.arrayBuffer()));
    // -sseof -0.1 pega o último frame; -frames:v 1 escreve 1 frame.
    // Aplica o mesmo crop 9:16 do forceImageTo916 pra garantir que a imagem
    // resultante já está em 1080x1920 (caso o Veo tenha gerado em outro aspect).
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .inputOptions(["-sseof", "-0.1"])
        .videoFilter("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1")
        .outputOptions(["-frames:v", "1", "-q:v", "2"])
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    const buffer = await readFile(outPath);
    return { bytesBase64Encoded: buffer.toString("base64"), mimeType: "image/jpeg" };
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

// Converte qualquer imagem (square, landscape, vertical não-padrão) pra
// 1080x1920 JPEG via ffmpeg center-crop. Necessário porque Veo image-to-video
// respeita o aspect ratio da imagem de entrada e ignora `aspectRatio:"9:16"`
// quando há mismatch — resultado: vídeo sai quadrado/horizontal se a foto não
// for vertical. Forçar 9:16 na imagem garante saída 9:16.
async function forceImageTo916(input: Buffer): Promise<Buffer> {
  const id = randomBytes(8).toString("hex");
  const inPath = join("/tmp", `narrator-img-in-${id}.bin`);
  const outPath = join("/tmp", `narrator-img-out-${id}.jpg`);
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .videoFilter("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1")
        .outputOptions(["-frames:v", "1", "-q:v", "2"])
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

// Baixa uma URL HTTPS e devolve {bytesBase64Encoded, mimeType} pronto pra
// Vertex AI. Quando opts.forceVertical=true (default), a imagem é convertida
// pra 1080x1920 JPEG via center-crop antes de virar base64.
export async function fetchImageForVeo(
  url: string,
  opts: { forceVertical?: boolean } = { forceVertical: true },
): Promise<VeoImageInput> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Falha ao baixar imagem do avatar (${res.status})`);
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  let mimeType =
    contentType.startsWith("image/")
      ? contentType
      : ext === "png" ? "image/png"
      : ext === "webp" ? "image/webp"
      : ext === "heic" ? "image/heic"
      : "image/jpeg";
  let buffer: Buffer = Buffer.from(await res.arrayBuffer());
  if (opts.forceVertical !== false) {
    buffer = await forceImageTo916(buffer);
    mimeType = "image/jpeg";
  }
  return { bytesBase64Encoded: buffer.toString("base64"), mimeType };
}

// Submete um Veo 3 Fast image-to-video. Foto do avatar como starting frame.
// Áudio: Veo gera áudio nativo (fala/lip-sync) quando o prompt pedir; quando
// pedir silêncio, o áudio sai limpo (ainda assim sai uma faixa silenciosa).
export async function submitVeoWithImage(
  prompt: string,
  image: VeoImageInput,
  accessToken?: string,
): Promise<VeoSubmitResult> {
  const token = accessToken ?? (await getVertexAccessToken());
  const res = await fetch(`${VERTEX_BASE}/${VEO_MODEL_ID}:predictLongRunning`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      instances: [{ prompt, image }],
      parameters: {
        aspectRatio: "9:16",
        durationSeconds: 8,
        sampleCount: 1,
        personGeneration: "allow_adult",
      },
    }),
  });
  const data = (await res.json()) as { name?: string; error?: { message: string } };
  if (!res.ok || !data.name) {
    throw new Error(`Veo submit (avatar) failed: ${data.error?.message ?? JSON.stringify(data)}`);
  }
  return { opName: data.name };
}

export interface VeoPollResult {
  done: boolean;
  videoBase64?: string;
  videoUri?: string;
  errorMessage?: string;
  raiBlocked?: boolean;
}

interface VertexOperationResponse {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: {
    videos?: Array<{ uri?: string; bytesBase64Encoded?: string; encoding?: string }>;
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
    generateVideoResponse?: {
      videos?: Array<{ uri?: string; bytesBase64Encoded?: string }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
}

export async function pollVeoOperation(opName: string, accessToken?: string): Promise<VeoPollResult> {
  const token = accessToken ?? (await getVertexAccessToken());
  const modelMatch = opName.match(/publishers\/google\/models\/([^/]+)\//);
  const modelId = modelMatch?.[1] ?? VEO_MODEL_ID;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${modelId}:fetchPredictOperation`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operationName: opName }),
  });
  const data = (await res.json()) as VertexOperationResponse;
  if (!res.ok) {
    return { done: false, errorMessage: `poll http ${res.status}: ${JSON.stringify(data).slice(0, 300)}` };
  }
  if (!data.done) return { done: false };

  if (data.error) {
    return { done: true, errorMessage: data.error.message };
  }

  const resp = data.response;
  const vr = resp?.generateVideoResponse ?? resp;
  const raiCount = vr?.raiMediaFilteredCount ?? 0;
  if (raiCount > 0) {
    return { done: true, raiBlocked: true, errorMessage: vr?.raiMediaFilteredReasons?.[0] ?? "Bloqueado por filtro de segurança" };
  }

  const videoEntry = resp?.videos?.[0] ?? vr?.videos?.[0];
  const uri = videoEntry?.uri;
  const b64 = videoEntry?.bytesBase64Encoded;
  if (!uri && !b64) {
    return { done: true, errorMessage: "Veo terminou mas não retornou vídeo" };
  }
  return { done: true, videoUri: uri, videoBase64: b64 };
}

export async function downloadVeoVideo(uriOrBase64: { uri?: string; base64?: string }, accessToken?: string): Promise<Buffer> {
  if (uriOrBase64.base64) {
    return Buffer.from(uriOrBase64.base64, "base64");
  }
  const uri = uriOrBase64.uri;
  if (!uri) throw new Error("downloadVeoVideo: no uri/base64");

  if (uri.startsWith("gs://")) {
    const token = accessToken ?? (await getVertexAccessToken());
    const withoutScheme = uri.slice(5);
    const slashIdx = withoutScheme.indexOf("/");
    const bucket = withoutScheme.slice(0, slashIdx);
    const object = encodeURIComponent(withoutScheme.slice(slashIdx + 1));
    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`;
    const res = await fetch(gcsUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GCS download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // HTTPS — Vertex às vezes retorna URLs assinadas; algumas precisam de API key
  const url = uri.includes("?")
    ? `${uri}&key=${process.env.GOOGLE_AI_API_KEY ?? ""}`
    : `${uri}?key=${process.env.GOOGLE_AI_API_KEY ?? ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Video download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export const VEO_TAKE_DURATION = 8;
