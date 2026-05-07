// Narrator Veo helpers: text-only Veo 3 Fast generation + polling.
// Diferente de animate-veo3 que envia uma imagem de referência, aqui é
// puramente texto → vídeo (sem image input).

import { GoogleAuth } from "google-auth-library";

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
