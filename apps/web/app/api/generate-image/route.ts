import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { put } from "@vercel/blob";
import { z } from "zod";

const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ── Model config ─────────────────────────────────────────────────────────────
// Override with env var GEMINI_IMAGE_MODEL to switch between:
//   gemini-2.5-flash-image          → Nano Banana (default, fastest)
//   gemini-3.1-flash-image-preview  → Nano Banana 2
//   gemini-3-pro-image-preview      → Nano Banana Pro (highest quality)
const DEFAULT_MODEL = "gemini-3-pro-image-preview";

function getModel(): string {
  return process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────

const schema = z.object({
  prompt: z.string().max(2000).default(""),
  aspectRatio: z.enum(["1:1", "9:16", "16:9", "3:4", "4:3"]).default("9:16"),
  referenceImageUrl: z.string().url().optional(), // image-to-image mode
  faceImageUrl: z.string().url().optional(),      // optional face to swap in
  outfitImageUrl: z.string().url().optional(),    // outfit transfer mode (referenceImageUrl = avatar)
  scenarioImageUrl: z.string().url().optional(),  // background/scenario reference
});

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string; // base64
        };
      }>;
    };
    finishReason?: string;
  }>;
  error?: { code: number; message: string; status: string };
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

    const { prompt, aspectRatio, referenceImageUrl, faceImageUrl, outfitImageUrl, scenarioImageUrl } = parsed.data;

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "GOOGLE_AI_API_KEY not configured" }, { status: 500 });

    const model = getModel();

    // Build parts array: reference image first (if any), then text instruction
    const parts: object[] = [];

    // Helper: fetch image → base64
    async function fetchBase64(url: string): Promise<{ data: string; mimeType: string }> {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Falha ao baixar imagem: ${url}`);
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      const mimeType = res.headers.get("content-type") ?? "image/jpeg";
      return { data, mimeType };
    }

    if (referenceImageUrl) {
      const ref = await fetchBase64(referenceImageUrl).catch(() => null);
      if (!ref) return NextResponse.json({ error: "Falha ao baixar imagem de referência" }, { status: 502 });

      if (outfitImageUrl) {
        // ── Outfit transfer (+ optional scenario) ─────────────────────────────
        const outfit = await fetchBase64(outfitImageUrl).catch(() => null);
        if (!outfit) return NextResponse.json({ error: "Falha ao baixar imagem da roupa" }, { status: 502 });

        parts.push({ text: "IMAGE 1 (avatar — preserve face, skin tone, hair style, hair color, and identity):" });
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
        parts.push({ text: "IMAGE 2 (clothing reference — reproduce this outfit exactly):" });
        parts.push({ inlineData: { mimeType: outfit.mimeType, data: outfit.data } });

        let instruction =
          `Take IMAGE 1 and recreate it with ONLY the clothing changed to match IMAGE 2. ` +
          `KEEP IDENTICAL from IMAGE 1: the person's face, skin tone, hair style, hair color, body pose, body position, expression, lighting, shadows, camera angle, and overall composition. ` +
          `CHANGE ONLY: the clothing and outfit — reproduce every detail from IMAGE 2 exactly: same colors, patterns, fabric textures, style, cut, and fit. `;

        if (scenarioImageUrl) {
          const scenario = await fetchBase64(scenarioImageUrl).catch(() => null);
          if (scenario) {
            parts.push({ text: "IMAGE 3 (background/scenario reference — use this exact environment as the background):" });
            parts.push({ inlineData: { mimeType: scenario.mimeType, data: scenario.data } });
            instruction += `Also CHANGE the background and environment to exactly match IMAGE 3 — reproduce the same location, scenery, lighting, and atmosphere. `;
          }
        } else {
          instruction += `KEEP IDENTICAL from IMAGE 1: background, environment, and scenery. `;
        }

        instruction +=
          `The result must look like IMAGE 1 but the person is wearing the outfit from IMAGE 2. ` +
          (prompt.trim() ? `Additional adjustments: ${prompt.trim()}. ` : ``) +
          `Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: instruction });

      } else if (faceImageUrl) {
        // ── Face swap (+ optional scenario) ───────────────────────────────────
        const face = await fetchBase64(faceImageUrl).catch(() => null);
        if (!face) return NextResponse.json({ error: "Falha ao baixar imagem do rosto" }, { status: 502 });

        parts.push({ text: "IMAGE 1 (base image — keep everything except the face):" });
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
        parts.push({ text: "IMAGE 2 (face donor — use only the face/identity from this person):" });
        parts.push({ inlineData: { mimeType: face.mimeType, data: face.data } });

        let instruction =
          `Take IMAGE 1 and recreate it replacing the subject's entire physical appearance with the person from IMAGE 2. ` +
          `KEEP IDENTICAL from IMAGE 1: body pose, body position, clothing, outfit, accessories, lighting, shadows, camera angle, and overall composition. ` +
          `CHANGE to match IMAGE 2: the subject's complete phenotype — face, facial features, skin tone, hair color, hair style, hair length, hair texture, eye shape, eye color, eyebrows, and all ethnic/racial physical traits. `;

        if (scenarioImageUrl) {
          const scenario = await fetchBase64(scenarioImageUrl).catch(() => null);
          if (scenario) {
            parts.push({ text: "IMAGE 3 (background/scenario reference — use this exact environment as the background):" });
            parts.push({ inlineData: { mimeType: scenario.mimeType, data: scenario.data } });
            instruction += `Also CHANGE the background and environment to exactly match IMAGE 3 — reproduce the same location, scenery, lighting, and atmosphere. `;
          }
        } else {
          instruction += `KEEP IDENTICAL from IMAGE 1: background, environment, and scenery. `;
        }

        instruction +=
          `The result must look like the exact same person from IMAGE 2 (same ethnicity, same hair, same complexion) but posed and dressed exactly as in IMAGE 1. ` +
          (prompt.trim() ? `Additionally apply: ${prompt.trim()}. ` : ``) +
          `Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: instruction });

      } else if (scenarioImageUrl) {
        // ── Copy mode + scenario only (no face swap) ──────────────────────────
        const scenario = await fetchBase64(scenarioImageUrl).catch(() => null);
        if (!scenario) return NextResponse.json({ error: "Falha ao baixar imagem do cenário" }, { status: 502 });

        parts.push({ text: "IMAGE 1 (person — preserve everything about this person and their clothing):" });
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
        parts.push({ text: "IMAGE 2 (background/scenario reference — use this exact environment as the new background):" });
        parts.push({ inlineData: { mimeType: scenario.mimeType, data: scenario.data } });

        const instruction =
          `Take IMAGE 1 and recreate it placing the person in the background from IMAGE 2. ` +
          `KEEP ABSOLUTELY IDENTICAL from IMAGE 1: the person's face, skin tone, hair style, hair color, clothing, outfit, accessories, body pose, body position, expression, and overall composition. ` +
          `CHANGE ONLY: the background and environment — replace it entirely with the scenery, location, lighting, and atmosphere from IMAGE 2. ` +
          `The person must look exactly the same as in IMAGE 1, just placed in the new environment from IMAGE 2. ` +
          (prompt.trim() ? `Additional adjustments: ${prompt.trim()}. ` : ``) +
          `Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: instruction });

      } else {
        // ── Plain copy mode ───────────────────────────────────────────────────
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
        const changeInstruction = prompt.trim()
          ? `Apply ONLY this change: ${prompt.trim()}. Everything else must remain absolutely identical — same person, face, hair, body, clothing, accessories, pose, expression, background, lighting, shadows, and overall composition. Output aspect ratio: ${aspectRatio}.`
          : `Reproduce this image exactly. Every detail must be identical — same person, face, hair, body, clothing, accessories, pose, expression, background, lighting, and shadows. Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: changeInstruction });
      }
    } else {
      parts.push({ text: `Generate a photorealistic image with aspect ratio ${aspectRatio}. ${prompt}` });
    }

    const googleRes = await fetch(
      `${GOOGLE_AI_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      }
    );

    const googleData = (await googleRes.json()) as GeminiImageResponse;

    if (!googleRes.ok || googleData.error) {
      console.error("[generate-image] Google AI error:", googleData);
      return NextResponse.json(
        { error: `Falha na geração de imagem: ${googleData.error?.message ?? JSON.stringify(googleData)}` },
        { status: 502 }
      );
    }

    // Extract inline image from response
    const imagePart = googleData.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      const finishReason = googleData.candidates?.[0]?.finishReason;
      console.error("[generate-image] No image. finishReason:", finishReason, "full:", JSON.stringify(googleData).slice(0, 500));
      return NextResponse.json(
        { error: "Modelo não retornou imagem. Tente reformular o prompt." },
        { status: 502 }
      );
    }

    const { mimeType, data: base64 } = imagePart.inlineData;
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";

    // Upload to Vercel Blob so the rest of the app can use it as inputImageUrl
    const buffer = Buffer.from(base64, "base64");
    const fileName = `generated-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(fileName, buffer, {
      access: "public",
      contentType: mimeType,
      addRandomSuffix: false,
    });

    return NextResponse.json({
      url: blob.url,
      model,
      mimeType,
    });
  } catch (error) {
    console.error("[generate-image] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
