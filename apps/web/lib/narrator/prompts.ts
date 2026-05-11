// Prompts pro Veo 3 Fast no narrator. Funções recebem `attempt` (0 = primeira
// tentativa, 1/2 = retries após bloqueio RAI). Quanto maior o attempt, mais
// "wholesome/tasteful/family-friendly" o prompt fica pra reduzir chance de o
// filtro de segurança Vertex bloquear de novo.

function safetyPrefix(attempt: number): string {
  if (attempt <= 0) return "";
  if (attempt === 1) {
    return "Wholesome, family-friendly, tasteful UGC content. The subject is fully clothed in casual everyday attire. No sensitive content of any kind. ";
  }
  // attempt 2+: máxima conservadoria
  return "Strictly safe-for-all-audiences content for advertising. Subject is fully clothed in modest casual everyday clothing. Friendly neutral facial expression. No body emphasis. Generic family-friendly aesthetic. ";
}

// Prompt do Veo quando o avatar DEVE falar (audioMode = veo_native).
export function buildAvatarSpeechPrompt(
  text: string,
  gender: "male" | "female",
  vibe: string | undefined,
  attempt: number = 0,
): string {
  const voiceLabel = gender === "male" ? "male" : "female";
  const styleSuffix = vibe?.trim() ? ` Tone: ${vibe.trim()}.` : "";
  return [
    safetyPrefix(attempt),
    `The person in the image speaks DIRECTLY into the camera (frontal selfie framing, like a UGC creator) saying EXACTLY these words in Brazilian Portuguese and NOTHING ELSE: "${text}".`,
    `Voice: natural Brazilian Portuguese ${voiceLabel} voice, intimate UGC narrator tone, conversational pace.${styleSuffix}`,
    "Identity, hair, skin tone, outfit, lighting, background and framing stay EXACTLY identical to the source image — do not change anything except the lips, eyes and natural micro head movement required to speak.",
    "Lips MUST be in tight sync with the spoken Brazilian Portuguese words. No camera movement other than gentle handheld micro-shake.",
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    "Audio is ONLY the spoken sentence in Brazilian Portuguese — NO music, NO ambient sound effects, NO other voices.",
    "STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. Do NOT speak in English, Mandarin, Spanish or any language other than Brazilian Portuguese. If you cannot pronounce the exact text, stay silent rather than improvise.",
  ].filter(Boolean).join(" ");
}

// Prompt do Veo quando o avatar fica MUDO (audioMode = tts_overlay).
export function buildAvatarSilentPrompt(vibe: string | undefined, attempt: number = 0): string {
  const styleSuffix = vibe?.trim() ? ` Tone: ${vibe.trim()}.` : "";
  return [
    safetyPrefix(attempt),
    "The person in the image stays SILENT — closed mouth or relaxed neutral expression, NO talking, NO lip movement that suggests speech.",
    "Allow only subtle natural micro movement: gentle blinking, slow head turn, soft breathing. No big gestures.",
    `Identity, hair, skin tone, outfit, lighting, background and framing stay EXACTLY identical to the source image.${styleSuffix}`,
    "No camera movement other than handheld micro-shake.",
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    "Audio must be completely silent — no voice, no music, no ambient sound. NO subtitles, NO captions, NO on-screen text.",
  ].filter(Boolean).join(" ");
}

// Prompt do Veo no modo B-roll (sem avatar) — comportamento legado.
export function buildBrollPrompt(visualPrompt: string, vibe: string | undefined, attempt: number = 0): string {
  const styleSuffix = vibe?.trim() ? ` Style: ${vibe.trim()}.` : "";
  return [
    safetyPrefix(attempt),
    visualPrompt,
    "The audio track must be completely silent — no voice, no speech, no music.",
    "No people speaking on camera. No subtitles. No text overlays. No on-screen captions.",
    "Mystical astrology and tarot atmosphere: deep cosmic blacks, violet and indigo tones with gold accents, volumetric god rays, smoke particles, lens flares, anamorphic light streaks.",
    "Dynamic revealing camera movement throughout — fast push-in, snap zoom, orbiting camera, crane reveal, vertigo zoom. Never static.",
    "STRICTLY VERTICAL portrait orientation, 9:16 aspect ratio, 1080x1920 mobile vertical full-frame composition, the subject and action FILL the entire vertical frame from top to bottom, no letterboxing, no pillarboxing, no black bars, no horizontal-style framing, framed for TikTok/Reels/Shorts.",
    `Cinematic premium B-roll, sharp focus, dramatic high-contrast color grading, suspenseful and revelatory pacing.${styleSuffix}`,
  ].filter(Boolean).join(" ");
}

export const MAX_RAI_RETRIES = 3;

// Fallback FINAL quando todos os retries com imagem falharam por RAI. Gera
// uma pessoa GENÉRICA falando o texto via text-only (sem foto do avatar).
// Resultado: pessoa diferente da foto original, mas o vídeo completa em vez
// de falhar. UI sinaliza isso pro user.
export function buildAvatarFallbackTextOnlyPrompt(text: string, gender: "male" | "female"): string {
  const voiceLabel = gender === "male" ? "male" : "female";
  return [
    "Wholesome, family-friendly, safe-for-all-audiences UGC video.",
    `A casual everyday ${voiceLabel === "male" ? "young adult man" : "young adult woman"} looks directly at the camera in selfie framing, speaks naturally in Brazilian Portuguese saying EXACTLY these words and nothing else: "${text}".`,
    `Voice: natural Brazilian Portuguese ${voiceLabel} voice, intimate UGC narrator tone, conversational pace.`,
    "Modest casual modern clothing. Neutral friendly facial expression. Soft natural daylight. Plain minimalist indoor background, slightly out of focus.",
    "Lips MUST be in tight sync with the spoken Brazilian Portuguese words. No camera movement other than handheld micro-shake.",
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    "Audio is ONLY the spoken sentence in Brazilian Portuguese — NO music, NO ambient sound effects, NO other voices.",
    "NO subtitles, NO captions, NO on-screen text, NO watermarks. Do NOT speak in English or any other language.",
  ].join(" ");
}
