// Nano Banana (Gemini image) helper pro modo "avatar_cutout" do narrator:
// pega a foto do avatar e edita SÓ o fundo trocando por um cenário descrito.
// Mantém a pessoa exatamente como está (rosto, cabelo, roupa, iluminação na
// pessoa). Output: blob URL da imagem editada, pronta pra alimentar Veo
// image-to-video.

import { put } from "@vercel/blob";
import { randomBytes } from "crypto";

const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-image-preview";

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
    finishReason?: string;
  }>;
  error?: { code: number; message: string; status: string };
}

async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    return { data: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

// Edita a foto do avatar trocando SÓ o fundo por uma cena descrita. Retorna
// URL pública no Blob. Em caso de falha, retorna null (caller deve usar a
// foto original como fallback).
export async function swapAvatarBackground(
  avatarImageUrl: string,
  sceneDescription: string,
  jobId: string,
  segmentIndex: number,
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[narrator/cutout] GOOGLE_AI_API_KEY missing — skipping background swap");
    return null;
  }

  const image = await fetchAsBase64(avatarImageUrl);
  if (!image) {
    console.error("[narrator/cutout] failed to fetch avatar image");
    return null;
  }

  const prompt = [
    "TASK: Replace ONLY the background of this image with a new scene. KEEP THE PERSON EXACTLY IDENTICAL.",
    "",
    "PERSON (MUST stay 100% identical, do NOT redraw, do NOT change):",
    "- Same face (every feature: eyes, nose, mouth, skin tone, freckles, marks)",
    "- Same hair (cut, color, position)",
    "- Same outfit (every garment, exact colors)",
    "- Same body pose and angle to camera",
    "- Same lighting falling ON the person (same direction, same color temperature, same shadow on face)",
    "- Same expression",
    "- Same framing within the image (don't move the person)",
    "",
    `NEW BACKGROUND (replaces the original background only):`,
    sceneDescription,
    "",
    "STYLE: cinematic, photographic realism, soft natural depth-of-field — the new background is slightly out of focus so the person stays in sharp focus. The new background should match the lighting direction and color temperature of the original photo so it looks like the person was actually photographed there.",
    "",
    "VERTICAL 9:16 PORTRAIT, 1080x1920. No text, no captions, no watermarks, no logos, no graphics added.",
  ].join("\n");

  try {
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: image.mimeType, data: image.data } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "9:16" },
      },
    };

    const res = await fetch(
      `${GOOGLE_AI_BASE}/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      },
    );

    const data = (await res.json()) as GeminiImageResponse;
    if (!res.ok || data.error) {
      console.error("[narrator/cutout] gemini error:", data.error ?? res.status);
      return null;
    }

    const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData) {
      console.error("[narrator/cutout] no image in response. finishReason:", data.candidates?.[0]?.finishReason);
      return null;
    }

    const buffer = Buffer.from(part.inlineData.data, "base64");
    const id = randomBytes(4).toString("hex");
    const blob = await put(`narrator-cutout-${jobId}-${segmentIndex}-${id}.jpg`, buffer, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return blob.url;
  } catch (err) {
    console.error("[narrator/cutout] request failed:", err);
    return null;
  }
}
