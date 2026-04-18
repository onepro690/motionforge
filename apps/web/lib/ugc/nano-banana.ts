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
  previousTakeResultUrl?: string | null,
  groupScene?: { peopleCount?: number; description?: string } | null,
  outfitOverride?: string | null
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

  console.log(`[nano-banana] ref: ${ref.data.length} chars, avatar: ${avatar.data.length} chars, prevResult: ${prevResult ? prevResult.data.length + " chars" : "none"}, group: ${groupScene ? JSON.stringify(groupScene) : "none"}`);

  // Se a cena de referência tem múltiplas pessoas (ex: coro, grupo gritando),
  // NÃO remover ninguém — trocar só o fenótipo do rosto principal pelo do avatar,
  // mantendo TODAS as demais pessoas exatamente onde estão.
  const isGroup = !!(groupScene && groupScene.peopleCount && groupScene.peopleCount > 1);
  const groupClause = isGroup
    ? `\n\nIMPORTANT — THIS IS A GROUP SCENE: The reference frame (IMAGE 1) shows ${groupScene!.peopleCount} people visible. You MUST keep ALL ${groupScene!.peopleCount} people in the result — do NOT remove anyone, do NOT merge people, do NOT leave only one person. Reproduce the EXACT same number of people in their EXACT same positions. Only ONE of them (the most prominent/central person) should have the face and phenotype swapped to match IMAGE 2. The other people keep their original faces and appearances from IMAGE 1 — DO NOT alter them. Every person from the original scene must be present in the result, same layout, same poses.`
    : "";

  // Outfit override: quando o pipeline pede "roupa diferente" por take.
  // Se definido, sobrescreve a instrução "match wardrobe from IMAGE 1" —
  // mantendo identidade, cenário, pose e enquadramento, mas TROCANDO a roupa.
  const hasOutfitOverride = !!(outfitOverride && outfitOverride.trim());
  const outfitClause = hasOutfitOverride
    ? `\n\nWARDROBE OVERRIDE — CHANGE THE CLOTHES: The reference frame (IMAGE 1) shows the ORIGINAL outfit, but you MUST replace the person's outfit with this new one: "${outfitOverride!.trim()}". This is the ONLY deviation allowed from IMAGE 1 — outfit changes, but EVERYTHING else stays pixel-identical (pose, camera, background, lighting, objects, composition, and the identity from IMAGE 2). The new outfit must fit the body naturally, respecting the same pose and framing as IMAGE 1. Do NOT keep any element of the original outfit.`
    : "";

  // Aspect ratio lock reforçado: garante saída 9:16 edge-to-edge (sem letterbox).
  const aspectClause = `\n\nASPECT RATIO: Output MUST be 9:16 vertical — the scene fills the entire portrait canvas edge-to-edge. If the input frame is landscape, REFRAME as a native vertical smartphone capture of the same person/scene. Do NOT pad with black bars, do NOT shrink the scene inside a vertical canvas.`;

  let instruction: string;
  let parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;

  if (prevResult) {
    // MODO 3 IMAGENS: take 2+ — tem o resultado do take anterior como referência
    // STRICT REFERENCE FIDELITY: reproduza IMAGE 1 pixel-a-pixel, troque SÓ a identidade.
    // IMAGE 2 (avatar original) é o GROUND TRUTH de identidade — IMAGE 3 só
    // reforça. Se IMAGE 3 drifted, o avatar da IMAGE 2 ainda manda.
    const wardrobeRule = hasOutfitOverride
      ? `- REPLACE the outfit from IMAGE 1 with the override specified below (this is the ONLY deviation allowed from IMAGE 1).\n`
      : `- Do NOT change the outfit, clothing, accessories, or wardrobe — match IMAGE 1 exactly.\n`;
    instruction =
      `STRICT REENACTMENT TASK — pixel-fidelity scene copy with identity swap only.\n` +
      `\nYou have THREE images:\n` +
      `IMAGE 1 = REFERENCE FRAME from a real video. This is the EXACT scene you must reproduce: background, pose, camera, framing, lighting, objects, composition${hasOutfitOverride ? "" : ", wardrobe"}.\n` +
      `IMAGE 2 = OFFICIAL AVATAR PHOTO of the person who MUST appear. This is the GROUND TRUTH of identity — the face/hair/skin in the output MUST MATCH IMAGE 2. Never generate a different person.\n` +
      `IMAGE 3 = previous successful result where the avatar was already placed in another scene. Use as SECONDARY identity reference; if IMAGE 3 conflicts with IMAGE 2, trust IMAGE 2.\n` +
      `\nYOUR TASK: produce an image that looks like IMAGE 1 pixel-for-pixel, with ONE and ONLY ONE change — the visible person becomes the person from IMAGE 2${hasOutfitOverride ? " wearing the override outfit described below" : ""}.\n` +
      `\n═══ FORBIDDEN (do not do ANY of these) ═══\n` +
      `- Do NOT reinterpret the scene. Do NOT generate a new scene "inspired" by IMAGE 1 — REPRODUCE IMAGE 1 exactly.\n` +
      `- Do NOT change the background, room, walls, furniture, floor, ceiling, or any scene element.\n` +
      `- Do NOT change the camera angle, zoom, framing, distance, or lens feel — match IMAGE 1 exactly.\n` +
      wardrobeRule +
      `- Do NOT change the body pose, hand position, head tilt, or gaze direction — match IMAGE 1 exactly.\n` +
      `- Do NOT change the lighting, shadows, color grading, or exposure — match IMAGE 1 exactly.\n` +
      `- Do NOT change the product being held or the objects visible — match IMAGE 1 exactly.\n` +
      `- Do NOT add or remove any people from the scene — keep the EXACT number of people in IMAGE 1.\n` +
      `- Do NOT generate a new random person. The ONLY acceptable face is the one from IMAGE 2.\n` +
      `\n═══ IDENTITY LOCK (copy EXACTLY from IMAGE 2 — this is the user's chosen avatar) ═══\n` +
      `The face, hair, skin tone, and body features of the main person must be PIXEL-LEVEL IDENTICAL to IMAGE 2. If placed side-by-side with IMAGE 2, the face must look like the same photograph of the same human. IMAGE 3 is only a hint about how the avatar looks in a scene — if IMAGE 3 drifted, fall back to IMAGE 2.\n` +
      `- EXACT same face shape, jawline, cheekbones, nose, lips, chin as IMAGE 2\n` +
      `- EXACT same skin tone as IMAGE 2 (sample the pixels — do NOT darken or lighten)\n` +
      `- EXACT same hair color, style, length, texture, hairline as IMAGE 2\n` +
      `- EXACT same eye color, shape, eyebrow shape as IMAGE 2\n` +
      `- EXACT same ethnicity, apparent age, and distinctive marks (moles, freckles) visible in IMAGE 2\n` +
      `- Do NOT add tattoos, piercings, scars, or marks not present in IMAGE 2\n` +
      `\n═══ SCENE LOCK (copy EXACTLY from IMAGE 1${hasOutfitOverride ? " — except wardrobe, see override" : ""}) ═══\n` +
      `Background, environment, room, every object, ${hasOutfitOverride ? "" : "wardrobe and its exact color/pattern, "}body pose and limb position, camera angle and distance, framing, lighting direction, shadow shape, color palette, composition — ALL pixel-identical to IMAGE 1.\n` +
      `\nThe face in IMAGE 1 is a DIFFERENT person — replace it with the face from IMAGE 2. Every other pixel of IMAGE 1 is preserved${hasOutfitOverride ? " except the outfit (see override below)" : ""}.\n` +
      `\nREMOVE any on-screen text, captions, subtitles, watermarks, logos, emojis, or graphic overlays that appear in IMAGE 1. Keep only the clean photographic scene.\n` +
      `\nOutput format: photorealistic UGC smartphone capture, 9:16 vertical aspect ratio.` + outfitClause + aspectClause + groupClause;

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
    // STRICT REFERENCE FIDELITY: reproduza IMAGE 1 pixel-a-pixel, troque SÓ a identidade.
    const wardrobeRule = hasOutfitOverride
      ? `- REPLACE the outfit from IMAGE 1 with the override specified below (this is the ONLY deviation allowed from IMAGE 1).\n`
      : `- Do NOT change the outfit, clothing, accessories, or wardrobe — match IMAGE 1 exactly.\n`;
    instruction =
      `STRICT REENACTMENT TASK — pixel-fidelity scene copy with identity swap only.\n` +
      `\nYou have TWO images:\n` +
      `IMAGE 1 = REFERENCE FRAME from a real video. This is the EXACT scene you must reproduce: background, pose, camera, framing, lighting, objects, composition${hasOutfitOverride ? "" : ", wardrobe"}.\n` +
      `IMAGE 2 = OFFICIAL AVATAR PHOTO — the person who MUST appear in the result. This is the GROUND TRUTH of identity.\n` +
      `\nYOUR TASK: produce an image that looks like IMAGE 1 pixel-for-pixel, with ONE and ONLY ONE change — the visible person becomes the person from IMAGE 2${hasOutfitOverride ? " wearing the override outfit described below" : ""}.\n` +
      `\n═══ FORBIDDEN (do not do ANY of these) ═══\n` +
      `- Do NOT reinterpret the scene. Do NOT generate a new scene "inspired" by IMAGE 1 — REPRODUCE IMAGE 1 exactly.\n` +
      `- Do NOT change the background, room, walls, furniture, floor, ceiling, or any scene element.\n` +
      `- Do NOT change the camera angle, zoom, framing, distance, or lens feel — match IMAGE 1 exactly.\n` +
      wardrobeRule +
      `- Do NOT change the body pose, hand position, head tilt, or gaze direction — match IMAGE 1 exactly.\n` +
      `- Do NOT change the lighting, shadows, color grading, or exposure — match IMAGE 1 exactly.\n` +
      `- Do NOT change the product being held or the objects visible — match IMAGE 1 exactly.\n` +
      `- Do NOT add or remove any people from the scene — keep the EXACT number of people in IMAGE 1.\n` +
      `- Do NOT generate a new random person. The ONLY acceptable face is the one from IMAGE 2.\n` +
      `\n═══ IDENTITY LOCK (copy EXACTLY from IMAGE 2) ═══\n` +
      `The face, hair, skin tone, and body features of the main person must be PIXEL-LEVEL IDENTICAL to IMAGE 2. If placed side-by-side with IMAGE 2, the face must look like the same photograph of the same human.\n` +
      `- EXACT same face shape, jawline, cheekbones, nose, lips, chin\n` +
      `- EXACT same skin tone (sample the pixels — do NOT darken or lighten)\n` +
      `- EXACT same hair color, style, length, texture, hairline\n` +
      `- EXACT same eye color, shape, eyebrow shape\n` +
      `- EXACT same ethnicity, apparent age, and distinctive marks (moles, freckles) visible in IMAGE 2\n` +
      `- Do NOT add tattoos, piercings, scars, or marks not present in IMAGE 2\n` +
      `\n═══ SCENE LOCK (copy EXACTLY from IMAGE 1${hasOutfitOverride ? " — except wardrobe, see override" : ""}) ═══\n` +
      `Background, environment, room, every object, ${hasOutfitOverride ? "" : "wardrobe and its exact color/pattern, "}body pose and limb position, camera angle and distance, framing, lighting direction, shadow shape, color palette, composition — ALL pixel-identical to IMAGE 1.\n` +
      `\nThe face in IMAGE 1 is a DIFFERENT person — replace it with the face from IMAGE 2. Every other pixel of IMAGE 1 is preserved${hasOutfitOverride ? " except the outfit (see override below)" : ""}.\n` +
      `\nREMOVE any on-screen text, captions, subtitles, watermarks, logos, emojis, or graphic overlays that appear in IMAGE 1. Keep only the clean photographic scene.\n` +
      `\nOutput format: photorealistic UGC smartphone capture, 9:16 vertical aspect ratio.` + outfitClause + aspectClause + groupClause;

    parts = [
      { text: "IMAGE 1 (scene/outfit/pose — reproduce pixel-for-pixel):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
      { text: "IMAGE 2 (the person who MUST appear — clone face/skin/hair EXACTLY):" },
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
    // STRICT REFERENCE FIDELITY: reproduza IMAGE 1 pixel-a-pixel, troque SÓ o fenótipo.
    instruction =
      `STRICT REENACTMENT TASK — pixel-fidelity scene copy with phenotype swap only.\n` +
      `\nYou have TWO images:\n` +
      `IMAGE 1 = REFERENCE FRAME from a real video. This is the EXACT scene you must reproduce: background, wardrobe, pose, camera, framing, lighting, objects, composition.\n` +
      `IMAGE 2 = PREVIOUS RESULT where the new phenotype (ethnicity/face/skin/hair) was already chosen. Use this as the PHENOTYPE LOCK.\n` +
      `\nYOUR TASK: produce an image that looks like IMAGE 1 pixel-for-pixel, with ONE and ONLY ONE change — every visible person gets the phenotype from IMAGE 2.\n` +
      `\n═══ FORBIDDEN (do not do ANY of these) ═══\n` +
      `- Do NOT reinterpret the scene. Do NOT generate a new scene "inspired" by IMAGE 1 — REPRODUCE IMAGE 1 exactly.\n` +
      `- Do NOT change the background, room, walls, furniture, floor, ceiling, or any scene element.\n` +
      `- Do NOT change the camera angle, zoom, framing, distance, or lens feel — match IMAGE 1 exactly.\n` +
      `- Do NOT change the outfit, clothing, accessories, or wardrobe — match IMAGE 1 exactly.\n` +
      `- Do NOT change the body pose, hand position, head tilt, or gaze direction — match IMAGE 1 exactly.\n` +
      `- Do NOT change the lighting, shadows, color grading, or exposure — match IMAGE 1 exactly.\n` +
      `- Do NOT change the product being held or the objects visible — match IMAGE 1 exactly.\n` +
      `- Do NOT add or remove any people from the scene — keep the EXACT number of people in IMAGE 1.\n` +
      `- Do NOT take the face from IMAGE 1 — that's the original person being replaced.\n` +
      `\n═══ PHENOTYPE LOCK (copy EXACTLY from IMAGE 2) ═══\n` +
      `The face, hair, skin tone, and body features of every visible person must be PIXEL-LEVEL IDENTICAL to IMAGE 2. Same face, same phenotype — not "similar", identical.\n` +
      `- EXACT same face shape, jawline, cheekbones, nose, lips, chin\n` +
      `- EXACT same skin tone (sample the pixels — do NOT darken or lighten)\n` +
      `- EXACT same hair color, style, length, texture, hairline\n` +
      `- EXACT same eye color, shape, eyebrow shape\n` +
      `- EXACT same ethnicity, apparent age, and distinctive features\n` +
      `- Do NOT add tattoos, piercings, scars, or marks not present in IMAGE 2\n` +
      `- If MULTIPLE people appear in IMAGE 1, ALL of them get the SAME phenotype from IMAGE 2\n` +
      `\n═══ SCENE LOCK (copy EXACTLY from IMAGE 1) ═══\n` +
      `Background, environment, room, every object, wardrobe and its exact color/pattern, body pose and limb position, camera angle and distance, framing, lighting direction, shadow shape, color palette, composition — ALL pixel-identical to IMAGE 1.\n` +
      `\nREMOVE any on-screen text, captions, subtitles, watermarks, logos, emojis, or graphic overlays that appear in IMAGE 1. Keep only the clean photographic scene.\n` +
      `\nOutput format: photorealistic UGC smartphone capture, 9:16 vertical aspect ratio.`;

    parts = [
      { text: "IMAGE 1 (scene to replicate pixel-for-pixel — everything except phenotype):" },
      { inlineData: { mimeType: ref.mimeType, data: ref.data } },
      { text: "IMAGE 2 (phenotype reference — clone face/skin/hair EXACTLY):" },
      { inlineData: { mimeType: prevResult.mimeType, data: prevResult.data } },
      { text: instruction },
    ];
  } else {
    // Take 1: escolhe um fenótipo novo via prompt
    // STRICT REFERENCE FIDELITY: reproduza a cena pixel-a-pixel, troque SÓ o fenótipo.
    instruction =
      `STRICT REENACTMENT TASK — pixel-fidelity scene copy with phenotype swap only.\n` +
      `\nYou have ONE image: a REFERENCE FRAME from a real video.\n` +
      `\nYOUR TASK: produce an image that looks like the reference frame pixel-for-pixel, with ONE and ONLY ONE change — every visible person gets a NEW phenotype (ethnicity/face/skin tone/hair/eye color/age), clearly different from the original. Pick any natural, photorealistic human phenotype. Keep the new phenotype consistent across all visible people.\n` +
      `\n═══ FORBIDDEN (do not do ANY of these) ═══\n` +
      `- Do NOT reinterpret the scene. Do NOT generate a new scene "inspired" by the reference — REPRODUCE it exactly.\n` +
      `- Do NOT change the background, room, walls, furniture, floor, ceiling, or any scene element.\n` +
      `- Do NOT change the camera angle, zoom, framing, distance, or lens feel — match the reference exactly.\n` +
      `- Do NOT change the outfit, clothing, accessories, or wardrobe — match the reference exactly.\n` +
      `- Do NOT change the body pose, hand position, head tilt, or gaze direction — match the reference exactly.\n` +
      `- Do NOT change the lighting, shadows, color grading, or exposure — match the reference exactly.\n` +
      `- Do NOT change the product being held or the objects visible — match the reference exactly.\n` +
      `- Do NOT add or remove any people from the scene — keep the EXACT number of people.\n` +
      `- Do NOT add tattoos, piercings, scars, birthmarks, or body modifications.\n` +
      `\n═══ PHENOTYPE SWAP (the ONLY change allowed) ═══\n` +
      `Replace the face, skin tone, hair, eye color, ethnicity, and apparent age of every visible person with a new, clearly different, photorealistic human phenotype. Keep the new phenotype consistent across all visible people. Nothing else changes.\n` +
      `\n═══ SCENE LOCK (copy EXACTLY from reference) ═══\n` +
      `Background, environment, room, every object, wardrobe and its exact color/pattern, body pose and limb position, camera angle and distance, framing, lighting direction, shadow shape, color palette, composition, product and product branding — ALL pixel-identical to the reference frame.\n` +
      `\nREMOVE any on-screen text, captions, subtitles, watermarks, logos, emojis, or graphic overlays from the scene overlay. Keep the clean photographic scene (product branding on the object itself stays intact).\n` +
      `\nOutput format: photorealistic UGC smartphone capture, 9:16 vertical aspect ratio.`;

    parts = [
      { text: "REFERENCE FRAME (reproduce pixel-for-pixel, swap only the phenotype):" },
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
