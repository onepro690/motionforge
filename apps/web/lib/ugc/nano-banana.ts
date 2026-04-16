// Nano Banana (Gemini image) helper pra editar o frame de referência trocando
// SÓ a pessoa. Mantém cenário, roupa, objetos, luz, enquadramento e pose —
// troca apenas a identidade física pela persona sorteada. O resultado vira
// input image-to-video do Veo, garantindo fidelidade visual ao vídeo original.

import { put } from "@vercel/blob";
import { personaToDescription, type UgcPersona } from "./personas";

const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3-pro-image-preview";

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

async function fetchBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    return { data, mimeType };
  } catch {
    return null;
  }
}

// Edita a thumbnail de referência: troca SÓ a pessoa pela persona sorteada.
// Retorna a URL pública no Vercel Blob, ou null em falha (pipeline faz
// fallback pro modo text-to-video).
export async function swapReferencePerson(
  referenceImageUrl: string,
  persona: UgcPersona
): Promise<{ url: string; mimeType: string } | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.warn("[nano-banana] GOOGLE_AI_API_KEY not set — skipping image edit");
    return null;
  }

  const ref = await fetchBase64(referenceImageUrl);
  if (!ref) {
    console.error("[nano-banana] failed to download reference image");
    return null;
  }

  const personaDesc = personaToDescription(persona);
  const instruction =
    `Take this image and recreate it replacing ONLY the person's identity with a new person matching this description: ${personaDesc}. ` +
    `KEEP ABSOLUTELY IDENTICAL: the background, environment, scenery, room, objects, product being held or shown, outfit/clothing, accessories, body pose, body position, hands position, facial expression direction, camera angle, framing, lighting, shadows, and overall composition. ` +
    `CHANGE ONLY: the person's physical phenotype — face, facial features, skin tone, hair color, hair style, hair length, hair texture, eye shape, eye color, and ethnic traits — to match the new persona description above. ` +
    `The result must look like the exact same photo with the exact same scene, outfit, pose and product, but with a completely different person (matching the new persona) wearing those same clothes in that same environment. ` +
    `Photorealistic UGC smartphone selfie aesthetic. Output aspect ratio: 9:16.`;

  const parts = [
    { inlineData: { mimeType: ref.mimeType, data: ref.data } },
    { text: instruction },
  ];

  const model = process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_MODEL;

  try {
    const googleRes = await fetch(
      `${GOOGLE_AI_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        signal: AbortSignal.timeout(90000),
      }
    );

    const googleData = (await googleRes.json()) as GeminiImageResponse;
    if (!googleRes.ok || googleData.error) {
      console.error("[nano-banana] google error:", googleData.error ?? googleRes.status);
      return null;
    }

    const imagePart = googleData.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      console.error("[nano-banana] no image in response. finishReason:", googleData.candidates?.[0]?.finishReason);
      return null;
    }

    const { mimeType, data: base64 } = imagePart.inlineData;
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const buffer = Buffer.from(base64, "base64");
    const fileName = `ugc-edited-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(fileName, buffer, {
      access: "public",
      contentType: mimeType,
      addRandomSuffix: false,
    });

    return { url: blob.url, mimeType };
  } catch (err) {
    console.error("[nano-banana] request failed:", err);
    return null;
  }
}

// Baixa um URL de imagem e retorna base64 — utilitário pra entregar a imagem
// editada pro Veo como input image-to-video.
export async function imageUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  return fetchBase64(url);
}
