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

// Modo "sem avatar": troca SOMENTE o fenótipo (etnia/rosto/cabelo/tom de pele)
// de TODAS as pessoas visíveis no frame. Nada mais muda — cenário, roupa,
// pose, objetos, produto, luz, enquadramento ficam 100% idênticos.
//
// referenceFrameUrl: frame extraído do vídeo de referência.
// previousTakeResultUrl: (opcional) resultado do take anterior — para manter
//   o MESMO fenótipo em todos os takes do vídeo.
export async function swapAllPhenotypes(
  referenceFrameUrl: string,
  previousTakeResultUrl?: string | null
): Promise<{ url: string; mimeType: string } | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[nano-banana] GOOGLE_AI_API_KEY not set — skipping image edit");
    return null;
  }

  console.log(`[nano-banana/phenotype] downloading reference frame: ${referenceFrameUrl.substring(0, 80)}...`);
  const ref = await fetchBase64(referenceFrameUrl);
  if (!ref) {
    console.error("[nano-banana/phenotype] failed to download reference frame");
    return null;
  }

  let prevResult: { data: string; mimeType: string } | null = null;
  if (previousTakeResultUrl) {
    prevResult = await fetchBase64(previousTakeResultUrl);
  }

  let instruction: string;
  let parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;

  if (prevResult) {
    // Takes 2+: reusa fenótipo do take 1 para consistência
    instruction =
      `You have TWO images.\n` +
      `IMAGE 1: A frame from a reference video showing a specific scene — background, outfit, pose, product, lighting, framing.\n` +
      `IMAGE 2: A PREVIOUS RESULT where the person's phenotype (ethnicity, face, skin tone, hair) was already swapped. Use this as the EXACT phenotype reference for the person in the new result.\n` +
      `\nYour task: Recreate IMAGE 1 EXACTLY, but every person visible must have the phenotype shown in IMAGE 2.\n` +
      `\nFROM IMAGE 2 (copy ONLY the person's physical identity):\n` +
      `- EXACT same face shape and facial features\n` +
      `- EXACT same skin tone (do NOT darken or lighten)\n` +
      `- EXACT same hair color, style, length, texture\n` +
      `- EXACT same eye color, eye shape\n` +
      `- EXACT same ethnicity and age range\n` +
      `\nFROM IMAGE 1 (copy EVERYTHING ELSE, pixel-perfect):\n` +
      `- Exact same background, room, environment, scenery\n` +
      `- Exact same outfit/clothing (color, type, style)\n` +
      `- Exact same body pose, hand position, gestures\n` +
      `- Exact same camera angle, framing, composition\n` +
      `- Exact same lighting, shadows, color grading\n` +
      `- Exact same objects and product being shown/held\n` +
      `\nIf MULTIPLE people appear in IMAGE 1, ALL of them must get a phenotype matching IMAGE 2 (or consistent with it).\n` +
      `DO NOT add tattoos, piercings, scars, birthmarks, moles, or ANY body modifications not in IMAGE 2.\n` +
      `REMOVE all text, captions, subtitles, watermarks, logos, letters, numbers, emojis. Pure visual only.\n` +
      `Photorealistic UGC smartphone selfie quality. Output aspect ratio: 9:16 vertical.`;

    parts = [
      { text: "IMAGE 1 (scene to replicate — everything except the person's phenotype):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
      { text: "IMAGE 2 (phenotype reference — person MUST look like this):" },
      { inlineData: { mimeType: prevResult.mimeType, data: prevResult.data } },
      { text: instruction },
    ];
  } else {
    // Take 1: escolhe um fenótipo novo via prompt
    instruction =
      `You have ONE image: a frame from a reference video.\n` +
      `\nYour task: Recreate this EXACT image, pixel-perfect, with one and only one change — replace the PHENOTYPE of EVERY person visible (ethnicity, face shape, facial features, skin tone, hair color/style/length, eye color, age) with a DIFFERENT phenotype from what is shown. Pick any natural, photorealistic human phenotype that is clearly different from the original.\n` +
      `\nKEEP 100% identical (do NOT alter ANY of these):\n` +
      `- Background, room, environment, scenery, every object visible\n` +
      `- Outfit/clothing: exact same color, type, style, fit, accessories\n` +
      `- Body pose, hand position, gestures, body proportions\n` +
      `- Camera angle, framing, distance, composition\n` +
      `- Lighting direction, shadows, exposure, color grading\n` +
      `- The product being held or shown — pixel identical\n` +
      `- Any text/UI inside the product (keep product branding intact)\n` +
      `\nONLY CHANGE: face, skin tone, hair, eye color, ethnicity, apparent age — the physical identity of the people.\n` +
      `\nIf MULTIPLE people appear, change ALL of them to the new phenotype (keep them consistent with each other or naturally varied, but all different from the original).\n` +
      `\nDO NOT add tattoos, piercings, scars, birthmarks, moles, or body modifications.\n` +
      `REMOVE all on-screen text, captions, subtitles, watermarks, logos, letters, numbers, emojis from the scene overlay. Pure visual content only.\n` +
      `Photorealistic UGC smartphone selfie quality. Output aspect ratio: 9:16 vertical.`;

    parts = [
      { text: "Reference frame (replicate everything except the person's phenotype):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
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
      console.error("[nano-banana/phenotype] google error:", googleData.error ?? googleRes.status);
      return null;
    }

    const imagePart = googleData.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      console.error("[nano-banana/phenotype] no image in response. finishReason:", googleData.candidates?.[0]?.finishReason);
      return null;
    }

    const { mimeType, data: base64 } = imagePart.inlineData;
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const buffer = Buffer.from(base64, "base64");
    const fileName = `ugc-pheno-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const blob = await put(fileName, buffer, {
      access: "public",
      contentType: mimeType,
      addRandomSuffix: false,
    });

    return { url: blob.url, mimeType };
  } catch (err) {
    console.error("[nano-banana/phenotype] request failed:", err);
    return null;
  }
}

// Baixa um URL de imagem e retorna base64
export async function imageUrlToBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  return fetchBase64(url);
}
