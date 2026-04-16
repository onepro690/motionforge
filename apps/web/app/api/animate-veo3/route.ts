import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@motion/database";
import sharp from "sharp";
import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "gen-lang-client-0466084510";
const LOCATION   = "us-central1";
const VERTEX_BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models`;

const VEO3_MODEL_IDS: Record<string, string> = {
  "veo3-fast":    "veo-3.0-fast-generate-001",
  "veo3-quality": "veo-3.0-generate-001",
};

const ASPECT_RATIO_MAP: Record<string, string> = {
  RATIO_16_9: "16:9",
  RATIO_9_16: "9:16",
  RATIO_1_1: "1:1",
  RATIO_4_3: "4:3",
};

const schema = z.object({
  inputImageUrl: z.string().url(),
  generatedPrompt: z.string().min(5),
  aspectRatio: z.enum(["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3"]).default("RATIO_9_16"),
  promptText: z.string().optional(),
  model: z.enum(["veo3-fast", "veo3-quality"]).default("veo3-fast"),
});

// Get a short-lived Bearer token from the service account JSON
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

// Center-crop to exact aspect ratio so Veo uses the right output dimensions
async function cropToAspectRatio(buffer: Buffer, aspectRatioStr: string): Promise<Buffer> {
  const [wRatio, hRatio] = aspectRatioStr.split(":").map(Number);
  const img = sharp(buffer);
  const { width = 0, height = 0 } = await img.metadata();
  const targetAspect = wRatio / hRatio;
  const currentAspect = width / height;

  let cropWidth: number;
  let cropHeight: number;

  if (currentAspect > targetAspect) {
    cropHeight = height;
    cropWidth = Math.round(height * targetAspect);
  } else {
    cropWidth = width;
    cropHeight = Math.round(width / targetAspect);
  }

  const left = Math.round((width - cropWidth) / 2);
  const top  = Math.round((height - cropHeight) / 2);
  return img.extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer();
}

function flattenPrompt(generatedPrompt: string): { prompt: string; hasSpeech: boolean } {
  try {
    const json = JSON.parse(generatedPrompt) as Record<string, unknown>;
    const parts: string[] = [];

    const speech = json.speech ? String(json.speech).trim() : "";
    const lang = json.speech_language ? String(json.speech_language).trim() : "Brazilian Portuguese";
    if (speech) {
      parts.push(
        `The person is talking naturally in ${lang}, saying: "${speech}".`
      );
    }

    // When speech is present, keep the prompt minimal so the model focuses on the exact words
    if (!speech) {
      // Explicit instruction: mouth closed, no speaking, no audio
      parts.push(
        "The person's mouth is completely closed throughout the entire video. " +
        "No speaking, no vocalization, no lip movement, no mouthing words. " +
        "The audio track must be completely silent — no voice, no speech, no talking."
      );
      if (json.motion_detail) parts.push(String(json.motion_detail));
      if (json.motion_type) parts.push(String(json.motion_type));
      if (json.style) parts.push(String(json.style));
      if (json.rhythm) parts.push(String(json.rhythm));
      if (json.facial_expression) parts.push(String(json.facial_expression));
      if (json.quality) {
        const cleaned = String(json.quality).replace(/,?\s*when speaking:.*$/i, "").trim();
        if (cleaned) parts.push(cleaned);
      }
    }

    return { prompt: parts.filter(Boolean).join(". "), hasSpeech: !!speech };
  } catch {
    return { prompt: generatedPrompt, hasSpeech: false };
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.errors }, { status: 400 });
    }

    const { inputImageUrl, generatedPrompt, aspectRatio, promptText, model } = parsed.data;

    const { prompt, hasSpeech } = flattenPrompt(generatedPrompt);
    console.log("[animate-veo3] hasSpeech:", hasSpeech, "prompt:", prompt.slice(0, 200));
    const veoModel = VEO3_MODEL_IDS[model] ?? "veo-3.0-generate-001";
    const targetAspectStr = ASPECT_RATIO_MAP[aspectRatio] ?? "9:16";

    // Fetch + crop input image
    const imgRes = await fetch(inputImageUrl);
    if (!imgRes.ok) return NextResponse.json({ error: "Falha ao baixar imagem de entrada" }, { status: 502 });
    const rawBuffer = Buffer.from(await imgRes.arrayBuffer());
    const croppedBuffer = await cropToAspectRatio(rawBuffer, targetAspectStr);
    const imgBase64 = croppedBuffer.toString("base64");

    // Get Vertex AI Bearer token
    const accessToken = await getAccessToken();

    const vertexRes = await fetch(
      `${VERTEX_BASE}/${veoModel}:predictLongRunning`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          instances: [
            {
              prompt,
              image: { bytesBase64Encoded: imgBase64, mimeType: "image/jpeg" },
            },
          ],
          parameters: {
            aspectRatio: targetAspectStr,
            durationSeconds: 8,
            sampleCount: 1,
            // Note: generateAudio is NOT sent — the Vertex AI Veo3 API doesn't accept this
            // parameter and rejects the request when it's present. Speech is driven entirely
            // by the prompt text when hasSpeech=true, and by the "mouth closed / silent"
            // instruction when hasSpeech=false.
          },
        }),
      }
    );

    const vertexData = (await vertexRes.json()) as {
      name?: string;
      error?: { code: number; message: string };
    };

    if (!vertexRes.ok || vertexData.error || !vertexData.name) {
      console.error("[animate-veo3] Vertex AI error:", vertexData);
      return NextResponse.json(
        { error: `Falha ao criar task Veo 3: ${vertexData.error?.message ?? JSON.stringify(vertexData)}` },
        { status: 502 }
      );
    }

    const job = await prisma.generationJob.create({
      data: {
        userId: session.user.id,
        status: "PROCESSING",
        provider: model,
        inputImageUrl,
        promptText: promptText ?? generatedPrompt,
        generatedPrompt,
        aspectRatio,
        maxDuration: 8,
        externalTaskId: vertexData.name,
        startedAt: new Date(),
      },
    });

    return NextResponse.json({ id: job.id, status: job.status, externalTaskId: vertexData.name });
  } catch (error) {
    console.error("[animate-veo3] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno ao criar job Veo 3" },
      { status: 500 }
    );
  }
}
