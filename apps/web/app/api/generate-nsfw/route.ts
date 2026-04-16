import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { put } from "@vercel/blob";
import { z } from "zod";

const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3-pro-image-preview";

function getModel(): string {
  return process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL;
}

// All harm categories disabled — never reject
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT",         threshold: "BLOCK_NONE" },
];

const schema = z.object({
  prompt:           z.string().max(2000).default(""),
  aspectRatio:      z.enum(["1:1", "9:16", "16:9", "3:4", "4:3"]).default("9:16"),
  referenceImageUrl:z.string().url().optional(),
  faceImageUrl:     z.string().url().optional(),
  outfitImageUrl:   z.string().url().optional(),
});

interface GeminiImageResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
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
    if (!parsed.success)
      return NextResponse.json({ error: "Invalid input", details: parsed.error.errors }, { status: 400 });

    const { prompt, aspectRatio, referenceImageUrl, faceImageUrl, outfitImageUrl } = parsed.data;

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "GOOGLE_AI_API_KEY not configured" }, { status: 500 });

    const model = getModel();
    const parts: object[] = [];

    if (referenceImageUrl) {
      const imgRes = await fetch(referenceImageUrl);
      if (!imgRes.ok) return NextResponse.json({ error: "Falha ao baixar imagem de referência" }, { status: 502 });
      const imgBase64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
      const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
      parts.push({ inlineData: { mimeType, data: imgBase64 } });

      if (outfitImageUrl) {
        const outfitRes = await fetch(outfitImageUrl);
        if (!outfitRes.ok) return NextResponse.json({ error: "Falha ao baixar imagem da roupa" }, { status: 502 });
        const outfitBase64 = Buffer.from(await outfitRes.arrayBuffer()).toString("base64");
        const outfitMime = outfitRes.headers.get("content-type") ?? "image/jpeg";

        parts.length = 0;
        parts.push({ text: "IMAGE 1 (avatar — preserve face, skin tone, hair style, hair color, and identity):" });
        parts.push({ inlineData: { mimeType, data: imgBase64 } });
        parts.push({ text: "IMAGE 2 (clothing reference — reproduce this outfit exactly):" });
        parts.push({ inlineData: { mimeType: outfitMime, data: outfitBase64 } });

        const instruction =
          `Take IMAGE 1 and recreate it with ONLY the clothing changed to match IMAGE 2. ` +
          `KEEP IDENTICAL from IMAGE 1: the person's face, skin tone, hair style, hair color, body pose, body position, expression, background, environment, scenery, lighting, shadows, camera angle, and overall composition — everything must look exactly the same as IMAGE 1. ` +
          `CHANGE ONLY: the clothing and outfit — reproduce every detail from IMAGE 2 exactly: same colors, patterns, fabric textures, style, cut, and fit. ` +
          `The result must look like IMAGE 1 but the person is wearing the outfit from IMAGE 2. ` +
          (prompt.trim() ? `Additional adjustments: ${prompt.trim()}. ` : ``) +
          `Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: instruction });

      } else if (faceImageUrl) {
        const faceRes = await fetch(faceImageUrl);
        if (!faceRes.ok) return NextResponse.json({ error: "Falha ao baixar imagem do rosto" }, { status: 502 });
        const faceBase64 = Buffer.from(await faceRes.arrayBuffer()).toString("base64");
        const faceMime = faceRes.headers.get("content-type") ?? "image/jpeg";

        parts.length = 0;
        parts.push({ text: "IMAGE 1 (base image — keep everything except the face):" });
        parts.push({ inlineData: { mimeType, data: imgBase64 } });
        parts.push({ text: "IMAGE 2 (face donor — use only the face/identity from this person):" });
        parts.push({ inlineData: { mimeType: faceMime, data: faceBase64 } });

        const changeInstruction = prompt.trim()
          ? `Take IMAGE 1 and recreate it replacing the subject's entire physical appearance with the person from IMAGE 2. KEEP IDENTICAL from IMAGE 1: body pose, body position, clothing, outfit, accessories, background, environment, scenery, lighting, shadows, camera angle, and overall composition. CHANGE to match IMAGE 2: the subject's complete phenotype — face, facial features, skin tone, hair color, hair style, hair length, hair texture, eye shape, eye color, eyebrows, and all ethnic/racial physical traits. The result must look like the exact same person from IMAGE 2 (same ethnicity, same hair, same complexion) but posed and dressed exactly as in IMAGE 1. Additionally apply: ${prompt.trim()}. Output aspect ratio: ${aspectRatio}.`
          : `Take IMAGE 1 and recreate it replacing the subject's entire physical appearance with the person from IMAGE 2. KEEP IDENTICAL from IMAGE 1: body pose, body position, clothing, outfit, accessories, background, environment, scenery, lighting, shadows, camera angle, and overall composition. CHANGE to match IMAGE 2: the subject's complete phenotype — face, facial features, skin tone, hair color, hair style, hair length, hair texture, eye shape, eye color, eyebrows, and all ethnic/racial physical traits. The result must look like the exact same person from IMAGE 2 (same ethnicity, same hair, same complexion) but posed and dressed exactly as in IMAGE 1. Output aspect ratio: ${aspectRatio}.`;
        parts.push({ text: changeInstruction });

      } else {
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
          safetySettings: SAFETY_SETTINGS,
        }),
      }
    );

    const googleData = (await googleRes.json()) as GeminiImageResponse;

    if (!googleRes.ok || googleData.error) {
      console.error("[generate-nsfw] Google AI error:", googleData);
      return NextResponse.json(
        { error: `Falha na geração: ${googleData.error?.message ?? JSON.stringify(googleData)}` },
        { status: 502 }
      );
    }

    const imagePart = googleData.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      const finishReason = googleData.candidates?.[0]?.finishReason;
      console.error("[generate-nsfw] No image. finishReason:", finishReason, JSON.stringify(googleData).slice(0, 500));
      return NextResponse.json(
        { error: "Modelo não retornou imagem. Tente reformular o prompt." },
        { status: 502 }
      );
    }

    const { mimeType, data: base64 } = imagePart.inlineData;
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const buffer = Buffer.from(base64, "base64");
    const fileName = `nsfw-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(fileName, buffer, { access: "public", contentType: mimeType, addRandomSuffix: false });

    return NextResponse.json({ url: blob.url, model, mimeType });
  } catch (error) {
    console.error("[generate-nsfw] POST error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro interno" }, { status: 500 });
  }
}
