// Prompts pro Veo 3 Fast no narrator. Funções recebem `attempt` (0 = primeira
// tentativa, 1/2 = retries após bloqueio RAI). Quanto maior o attempt, mais
// "wholesome/tasteful/family-friendly" o prompt fica pra reduzir chance de o
// filtro de segurança Vertex bloquear de novo.
//
// `language` define em qual idioma Veo deve falar (pt-BR, en, es). Detectado
// automaticamente da copy via `detectLanguage()` em language.ts.

import { languageLabel, forbiddenLanguagesClause, type NarratorLanguage } from "./language";

function safetyPrefix(attempt: number): string {
  if (attempt <= 0) return "";
  if (attempt === 1) {
    return "Wholesome, family-friendly, tasteful UGC content. The subject is fully clothed in casual everyday attire. No sensitive content of any kind. ";
  }
  // attempt 2+: máxima conservadoria
  return "Strictly safe-for-all-audiences content for advertising. Subject is fully clothed in modest casual everyday clothing. Friendly neutral facial expression. No body emphasis. Generic family-friendly aesthetic. ";
}

// PRONUNCIATION LOCK — repetido várias vezes ao longo do prompt pra blindar
// pronúncia. Veo 3 nativo costuma "mumbleizar" palavras menos comuns ou pular
// sílabas; reforço fonético explícito reduz drasticamente esses erros.
function pronunciationLock(text: string, language: NarratorLanguage): string {
  const lang = languageLabel(language);
  return [
    `PRONUNCIATION LOCK — ${lang} ONLY. Articulate clearly, syllable by syllable, at a slightly slower than conversational pace if needed to be intelligible.`,
    `Pronounce EVERY SINGLE WORD exactly as written. DO NOT skip, omit, shorten, contract, mumble, swallow, slur, or paraphrase any word. DO NOT add interjections, sighs, fillers ("hum", "uh", "like", "you know"), or any extra sound. DO NOT improvise — read the text verbatim.`,
    `VERBATIM LOCK: treat the text below as a LEGAL TRANSCRIPT to be read WORD-FOR-WORD. DO NOT add ANY word that is not present. DO NOT remove ANY word that is present. DO NOT substitute words with synonyms or rephrase. DO NOT change word order. DO NOT add filler or connective words. The output spoken sentence must match the written text 100% verbatim, period.`,
    `CONTINUOUS DELIVERY LOCK: Speak the entire text CONTINUOUSLY from start to end of the take, with even pacing and NO long pauses, NO silent staring, NO frozen frames, NO trailing silence at the end. Begin speaking immediately (within first 0.3 seconds of the take). End the take naturally right after the last word — do not stare into the camera afterwards. If the text is short, fill the remaining time with a brief natural facial expression (gentle smile, subtle nod) — never with empty silence.`,
    `If a word is uncommon or seems foreign, read it letter-by-letter following standard ${lang} phonetic rules. Treat every word as essential — no word can be left out or unclear.`,
    `The EXACT VERBATIM sentence that MUST be spoken, in ${lang}, with every word in this exact order, NOTHING added, NOTHING removed:`,
    `"${text}"`,
  ].join(" ");
}

// Voice descriptor super específico pra reduzir variação de timbre entre takes.
// Veo nativo escolhe voz por take, então quanto mais constraints, menor a
// chance de o timbre mudar.
function voiceLock(gender: "male" | "female", language: NarratorLanguage): string {
  const lang = languageLabel(language);
  const profile = gender === "male"
    ? `deep warm baritone ${lang} male voice, approximately 30 years old, slight gravelly texture, intimate confident UGC creator tone`
    : `warm mellow ${lang} female voice, approximately 26 years old, soft breathy texture, intimate confident UGC creator tone`;
  return [
    `VOICE LOCK: ${profile}.`,
    `Pace: slow-to-medium conversational, ~140 words per minute. Pitch: consistent and steady throughout.`,
    `SAME voice characteristics across the entire video — same pitch, same timbre, same pace, same energy. NEVER change voice mid-sentence or between segments. Imagine ONE single creator recording everything in a single continuous take.`,
  ].join(" ");
}

// NEGATIVE LOCK pra áudio: bloqueia música, SFX, ruído ambiente. Voz seca.
function audioNegativeLock(): string {
  return [
    `AUDIO NEGATIVE LOCK: ABSOLUTELY NO music of any kind. NO instrumental. NO soundtrack. NO background music. NO score. NO ambient sound. NO room tone. NO sound effects. NO foley. NO other voices. NO crowd noise. NO nature sounds. NO synth pads. NO drone. NO whoosh. NO impact. NO transition sound.`,
    `The audio track must contain ONLY the dry spoken voice — as if it were a raw phone voice memo recorded in a silent room with zero processing, zero post-production, zero background.`,
  ].join(" ");
}

// Prompt do Veo quando o avatar DEVE falar (audioMode = veo_native).
export function buildAvatarSpeechPrompt(
  text: string,
  gender: "male" | "female",
  vibe: string | undefined,
  attempt: number = 0,
  language: NarratorLanguage = "pt-BR",
): string {
  const styleSuffix = vibe?.trim() ? ` Tone: ${vibe.trim()}.` : "";
  const lang = languageLabel(language);
  return [
    safetyPrefix(attempt),
    `The person in the image speaks DIRECTLY into the camera (frontal selfie framing, like a UGC creator) saying EXACTLY these words in ${lang} and NOTHING ELSE: "${text}".`,
    pronunciationLock(text, language),
    voiceLock(gender, language),
    audioNegativeLock(),
    styleSuffix ? `Visual tone: ${styleSuffix.trim()}.` : "",
    "Identity, hair, skin tone, outfit, lighting, background and framing stay EXACTLY identical to the source image — do not change anything except the lips, eyes and natural micro head movement required to speak.",
    `Lips MUST be in tight sync with the spoken ${lang} words. No camera movement other than gentle handheld micro-shake.`,
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. ${forbiddenLanguagesClause(language)} If you cannot pronounce the exact text, stay silent rather than improvise.`,
    audioNegativeLock(),
    `FINAL PRONUNCIATION LOCK: every word of "${text}" must be spoken IN FULL, in ${lang}, audibly and correctly. NO word may be omitted, skipped, shortened, or mumbled. ${audioNegativeLock()}`,
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
export function buildAvatarFallbackTextOnlyPrompt(
  text: string,
  gender: "male" | "female",
  language: NarratorLanguage = "pt-BR",
): string {
  const subject = gender === "male" ? "young adult man" : "young adult woman";
  const lang = languageLabel(language);
  return [
    "Wholesome, family-friendly, safe-for-all-audiences UGC video.",
    `A casual everyday ${subject} looks directly at the camera in selfie framing, speaks naturally in ${lang} saying EXACTLY these words and nothing else: "${text}".`,
    pronunciationLock(text, language),
    voiceLock(gender, language),
    audioNegativeLock(),
    "Modest casual modern clothing. Neutral friendly facial expression. Soft natural daylight. Plain minimalist indoor background, slightly out of focus.",
    `Lips MUST be in tight sync with the spoken ${lang} words. No camera movement other than handheld micro-shake.`,
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    `NO subtitles, NO captions, NO on-screen text, NO watermarks. ${forbiddenLanguagesClause(language)}`,
    `FINAL PRONUNCIATION LOCK: every word of "${text}" must be spoken IN FULL, in ${lang}, audibly and correctly. NO word may be omitted, skipped, shortened, or mumbled. ${audioNegativeLock()}`,
  ].join(" ");
}
