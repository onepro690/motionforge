// Nano Banana (Gemini image) helper pra editar o frame de referência trocando
// SÓ a pessoa pelo avatar do usuário. Mantém cenário, roupa, objetos, luz,
// enquadramento e pose — troca apenas a identidade física.
//
// SEMPRE recebe pelo menos 2 imagens:
//   IMAGE 1 = frame extraído do vídeo de referência (cena, roupa, pose)
//   IMAGE 2 = foto do avatar/personagem do usuário
//
// Para takes 2+, recebe 3 imagens:
//   IMAGE 1 = frame de referência (cena deste take)
//   IMAGE 2 = foto original do avatar
//   IMAGE 3 = resultado do take 1 (a pessoa JÁ editada — garante consistência)

import { put } from "@vercel/blob";

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

// Troca a pessoa do frame de referência pelo avatar do usuário.
//
// referenceFrameUrl: frame extraído do vídeo de referência (cena/roupa/pose)
// avatarImageUrl: foto do personagem do usuário (a pessoa que deve aparecer)
// previousTakeResultUrl: (opcional) URL do resultado do take anterior — para
//   manter a MESMA aparência exata do avatar em todos os takes
export async function swapPersonWithAvatar(
  referenceFrameUrl: string,
  avatarImageUrl: string,
  previousTakeResultUrl?: string | null
): Promise<{ url: string; mimeType: string } | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[nano-banana] GOOGLE_AI_API_KEY not set — skipping image edit");
    return null;
  }

  console.log(`[nano-banana] downloading reference frame: ${referenceFrameUrl.substring(0, 80)}...`);
  const ref = await fetchBase64(referenceFrameUrl);
  if (!ref) {
    console.error("[nano-banana] failed to download reference frame");
    return null;
  }

  console.log(`[nano-banana] downloading avatar image: ${avatarImageUrl.substring(0, 80)}...`);
  const avatar = await fetchBase64(avatarImageUrl);
  if (!avatar) {
    console.error("[nano-banana] failed to download avatar image");
    return null;
  }

  // Para takes 2+: baixa o resultado do take anterior como referência extra
  let prevResult: { data: string; mimeType: string } | null = null;
  if (previousTakeResultUrl) {
    prevResult = await fetchBase64(previousTakeResultUrl);
    if (prevResult) {
      console.log(`[nano-banana] previous take result downloaded: ${prevResult.data.length} chars`);
    }
  }

  console.log(`[nano-banana] ref: ${ref.data.length} chars, avatar: ${avatar.data.length} chars, prevResult: ${prevResult ? prevResult.data.length + " chars" : "none"}`);

  let instruction: string;
  let parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;

  if (prevResult) {
    // MODO 3 IMAGENS: take 2+ — tem o resultado do take anterior como referência
    instruction =
      `You have THREE images.\n` +
      `IMAGE 1: A frame from a reference video showing a specific SCENE — background, outfit, pose, product, lighting.\n` +
      `IMAGE 2: The ORIGINAL PHOTO of the avatar/character.\n` +
      `IMAGE 3: A PREVIOUS RESULT where this avatar was already placed in a different scene. This shows EXACTLY how the avatar should look after editing.\n` +
      `\nYour task: Place the person from IMAGE 3 into the scene from IMAGE 1.\n` +
      `\nThe person in the result MUST look IDENTICAL to the person in IMAGE 3:\n` +
      `- EXACT same face shape and facial features\n` +
      `- EXACT same skin tone and skin color (do NOT darken or lighten)\n` +
      `- EXACT same hair color, hair style, hair length, hair texture\n` +
      `- EXACT same eye color and eye shape\n` +
      `- EXACT same ethnicity and physical traits\n` +
      `\nThe SCENE must come from IMAGE 1:\n` +
      `- Same background, room, environment\n` +
      `- Same outfit/clothing (color, type, style) as IMAGE 1\n` +
      `- Same body pose and hand position as IMAGE 1\n` +
      `- Same camera angle, framing, lighting as IMAGE 1\n` +
      `- Same objects and product as IMAGE 1\n` +
      `\nDO NOT change the person's skin color. DO NOT change hair. The face must be recognizable as the SAME person from IMAGE 3.\n` +
      `DO NOT add tattoos, piercings, scars, birthmarks, moles, or ANY body modifications that are NOT visible in IMAGE 2 and IMAGE 3. The person's body must be CLEAN and IDENTICAL to the original photos — no additions whatsoever.\n` +
      `REMOVE all text, captions, subtitles, watermarks, logos, symbols, letters, numbers, and emojis from the image. The output must be completely clean — zero on-screen text or graphics.\n` +
      `Photorealistic UGC smartphone selfie quality. Output aspect ratio: 9:16 vertical.`;

    parts = [
      { text: "IMAGE 1 (scene/outfit/pose — from this take's reference frame):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
      { text: "IMAGE 2 (original avatar photo):" },
      { inlineData: { mimeType: avatar.mimeType, data: avatar.data } },
      { text: "IMAGE 3 (previous take result — the person MUST look EXACTLY like this):" },
      { inlineData: { mimeType: prevResult.mimeType, data: prevResult.data } },
      { text: instruction },
    ];
  } else {
    // MODO 2 IMAGENS: take 1 — primeira edição
    instruction =
      `You have two images.\n` +
      `IMAGE 1: A frame from a reference video — it shows a specific scene with a person wearing specific clothes.\n` +
      `IMAGE 2: A photo of the person who MUST appear in the result.\n` +
      `\nYour task: Recreate IMAGE 1 but replace the person with the EXACT person from IMAGE 2.\n` +
      `\nThe person in the result MUST look IDENTICAL to IMAGE 2:\n` +
      `- EXACT same face shape and facial features as IMAGE 2\n` +
      `- EXACT same skin tone and skin color as IMAGE 2 (do NOT darken or lighten the skin)\n` +
      `- EXACT same hair color, style, length, and texture as IMAGE 2\n` +
      `- EXACT same eye color and shape as IMAGE 2\n` +
      `- EXACT same ethnicity as IMAGE 2\n` +
      `\nKEEP from IMAGE 1: background, environment, room, scenery, ALL objects, product being held/shown, outfit/clothing (color, type, style), accessories, body pose, body position, hands position, camera angle, framing, lighting direction, shadows, composition.\n` +
      `\nDO NOT change the skin color of the person from IMAGE 2. If IMAGE 2 shows a light-skinned person, the result must show a light-skinned person. The face must be recognizable as the same person from IMAGE 2.\n` +
      `DO NOT add tattoos, piercings, scars, birthmarks, moles, or ANY body modifications that are NOT visible in IMAGE 2. The person's body must be CLEAN and IDENTICAL to the original photo — no additions whatsoever.\n` +
      `REMOVE all text, captions, subtitles, watermarks, logos, symbols, letters, numbers, and emojis from the image. The output must be completely clean — zero on-screen text or graphics.\n` +
      `Photorealistic UGC smartphone selfie quality. Output aspect ratio: 9:16 vertical.`;

    parts = [
      { text: "IMAGE 1 (scene/outfit/pose reference):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
      { text: "IMAGE 2 (the person who MUST appear — match skin tone, face, hair EXACTLY):" },
      { inlineData: { mimeType: avatar.mimeType, data: avatar.data } },
      { text: instruction },
    ];
  }

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

// Baixa um URL de imagem e retorna base64
export async function imageUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  return fetchBase64(url);
}
