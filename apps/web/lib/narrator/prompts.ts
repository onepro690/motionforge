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
    `AUDIO PURITY LOCK — ZERO TOLERANCE: the audio track contains EXCLUSIVELY the dry spoken human voice. NOTHING ELSE under any circumstance.`,
    `ABSOLUTELY FORBIDDEN in the audio: music (any genre), instrumental, soundtrack, background music, score, melody, beat, rhythm, drums, piano, synth, pad, drone, ambient sound, room tone, atmosphere, reverb tail, sound effects, foley, whoosh, swoosh, impact, transition sound, sting, riser, sweep, sparkle, chime, bell, click, breath SFX, applause, crowd, nature sounds, wind, water, birds, dog, cat, any animal, traffic, machine.`,
    `Treat the deliverable as a raw phone voice memo recorded in a silent treated room with zero processing, zero post-production, zero background — JUST the voice, nothing layered underneath, nothing on top, nothing in the gaps between words.`,
  ].join(" ");
}

// Bloqueia animações estilizadas / transições / overlays gráficos. Veo às vezes
// adiciona "efeitos" tipo cortina de luz, partículas brilhantes, scene wipes
// entre cortes — não queremos NADA disso. Avatar steady, sem firulas.
function visualPurityLock(): string {
  return [
    `VISUAL PURITY LOCK: this is a SINGLE STEADY portrait shot of a person talking. NO animated graphics of any kind.`,
    `ABSOLUTELY FORBIDDEN visuals: animated transitions, scene wipes, curtain reveals, light streaks added in post, lens flares added, particle effects, sparkles, dust particles, smoke overlays, fog overlays, glow overlays, motion graphics, animated text, lower thirds, captions, subtitles, watermarks, logos, brand bumpers, intro/outro animations, color animation, animated gradients, animated lighting changes, animated shapes, animated icons, animated emojis, drawn elements, illustrated overlays, cartoon elements, anime style effects, anime lines, manga elements, comic effects, vignette animation, zoom punch effect, glitch, datamosh, RGB split, motion blur effect, speed ramp.`,
    `The shot must look like ONE continuous take from a phone selfie camera: steady framing, natural ambient room light, person talking to camera. Nothing more.`,
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
    visualPurityLock(),
    styleSuffix ? `Visual tone: ${styleSuffix.trim()}.` : "",
    "Identity, hair, skin tone, outfit, lighting, background and framing stay EXACTLY identical to the source image — do not change anything except the lips, eyes and natural micro head movement required to speak.",
    `Lips MUST be in tight sync with the spoken ${lang} words. No camera movement other than gentle handheld micro-shake.`,
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. ${forbiddenLanguagesClause(language)} If you cannot pronounce the exact text, stay silent rather than improvise.`,
    audioNegativeLock(),
    visualPurityLock(),
    `FINAL PRONUNCIATION LOCK: every word of "${text}" must be spoken IN FULL, in ${lang}, audibly and correctly. NO word may be omitted, skipped, shortened, or mumbled. ${audioNegativeLock()} ${visualPurityLock()}`,
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

// Prompt do Veo no modo B-roll (sem avatar) — comportamento legado AstroCopy.
// Injeta estética mystical/astrology em CIMA do visualPrompt. NÃO usar em
// mixed mode — lá o B-roll precisa ilustrar literalmente sem viés temático.
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

// Prompt do Veo pra B-roll GENÉRICO (modo mixed). Não injeta estética temática
// hardcoded — confia no visualPrompt do LLM pra dizer EXATAMENTE o que mostrar.
// Cinematográfico realista, ilustrando literalmente o que a copy fala.
export function buildBrollPromptGeneric(visualPrompt: string, attempt: number = 0): string {
  return [
    safetyPrefix(attempt),
    visualPrompt,
    "Photographic realism, cinematic short-form vertical content (TikTok/Reels/Shorts style).",
    "Subtle camera movement that supports the subject (slow push-in, slight handheld, or static if appropriate). Natural realistic lighting that fits the scene described above. Sharp focus on the subject, gentle depth of field.",
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame composition that fills the entire vertical frame from top to bottom. No letterboxing, no pillarboxing, no black bars.",
    "NO people speaking. NO subtitles. NO captions. NO on-screen text. NO watermarks. NO logos. NO motion graphics. NO animated overlays. NO sparkles. NO particles added in post. NO light streaks added.",
    "The audio track must be COMPLETELY SILENT — no voice, no music, no sound effects, no ambient sound. Treat audio as a muted clip.",
  ].filter(Boolean).join(" ");
}

// ─── MODO CONVERSATION ────────────────────────────────────────────────────
// Prompt do Veo pra take de conversa: foto tem 2 pessoas, apenas o speaker
// fala, a outra fica em silêncio absoluto. Risco principal: Veo3 às vezes
// anima as 2 bocas. Mitigação por attempt progressivo: posicional →
// reforço repetido 3x → descritor específico da pessoa.

function mouthIsolationLock(
  speakerSide: "LEFT" | "RIGHT",
  otherSide: "LEFT" | "RIGHT",
  attempt: number,
  descriptorSpeaker?: string,
  descriptorOther?: string,
): string {
  const blocks: string[] = [];
  blocks.push(
    `MOUTH ISOLATION LOCK — CRITICAL: Only ONE mouth may move in this entire shot — the mouth of the person on the ${speakerSide}. The mouth of the person on the ${otherSide} is FROZEN CLOSED throughout the entire take. ZERO mouth movement, ZERO jaw movement, ZERO lip parting on the ${otherSide} person.`,
  );
  if (attempt >= 1) {
    // Reforço — repete a restrição em formato diferente.
    blocks.push(
      `LISTENER LOCK: The person on the ${otherSide} is LISTENING ONLY. They remain completely silent with closed neutral lips, may blink naturally and may show subtle attentive facial micro-expressions (slight head tilt, occasional small nod), but their mouth NEVER opens, NEVER moves, NEVER speaks. They are NOT speaking. They are NOT talking. They are NOT vocalizing. They contribute ZERO audio to this take.`,
    );
    blocks.push(
      `SPEAKER LOCK: ONLY the person on the ${speakerSide} speaks. Their mouth moves naturally in tight sync with the spoken words. The other person stays quiet.`,
    );
  }
  if (attempt >= 2 && descriptorSpeaker && descriptorOther) {
    blocks.push(
      `IDENTITY-BASED LOCK: The ${descriptorSpeaker} (${speakerSide} side) is the one speaking. The ${descriptorOther} (${otherSide} side) stays SILENT with mouth closed — does not speak, does not move lips, does not vocalize.`,
    );
  }
  return blocks.join(" ");
}

export function buildConversationSpeechPrompt(args: {
  text: string;
  speaker: "A" | "B";
  genderA: "male" | "female";
  genderB: "male" | "female";
  language?: NarratorLanguage;
  attempt?: number;
  personDescriptorA?: string;
  personDescriptorB?: string;
}): string {
  const {
    text,
    speaker,
    genderA,
    genderB,
    language = "pt-BR",
    attempt = 0,
    personDescriptorA,
    personDescriptorB,
  } = args;
  const speakerSide = speaker === "A" ? "LEFT" : "RIGHT";
  const otherSide = speaker === "A" ? "RIGHT" : "LEFT";
  const speakerGender = speaker === "A" ? genderA : genderB;
  const descriptorSpeaker = speaker === "A" ? personDescriptorA : personDescriptorB;
  const descriptorOther = speaker === "A" ? personDescriptorB : personDescriptorA;
  const lang = languageLabel(language);
  return [
    safetyPrefix(attempt),
    `Two people sit side by side in the source image, both visible in the same vertical frame. The person on the ${speakerSide} side speaks DIRECTLY to camera saying EXACTLY these words in ${lang} and NOTHING ELSE: "${text}". The person on the ${otherSide} side stays silent and listens.`,
    mouthIsolationLock(speakerSide, otherSide, attempt, descriptorSpeaker, descriptorOther),
    pronunciationLock(text, language),
    voiceLock(speakerGender, language),
    audioNegativeLock(),
    visualPurityLock(),
    "Identity, hair, skin tone, clothing, framing, background and lighting of BOTH people stay EXACTLY identical to the source image — change nothing except the speaker's lips, eyes and subtle natural micro head movement required to speak.",
    `Lips of the ${speakerSide} person MUST be in tight sync with the spoken ${lang} words. The ${otherSide} person's lips MUST stay closed and motionless. No camera movement other than gentle handheld micro-shake.`,
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait composition that keeps BOTH people visible. No letterboxing, no pillarboxing, no black bars, no cropping that hides either person.",
    `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. ${forbiddenLanguagesClause(language)} If you cannot pronounce the exact text, stay silent rather than improvise.`,
    audioNegativeLock(),
    visualPurityLock(),
    mouthIsolationLock(speakerSide, otherSide, attempt, descriptorSpeaker, descriptorOther),
    `FINAL PRONUNCIATION LOCK: every word of "${text}" must be spoken IN FULL, in ${lang}, audibly and correctly by the ${speakerSide} person only. NO word may be omitted, skipped, shortened, or mumbled. The ${otherSide} person remains MUTE throughout. ${audioNegativeLock()} ${visualPurityLock()}`,
  ].filter(Boolean).join(" ");
}

// ─── MODO ROTEIRO (2 PERSONAGENS) — buildScriptShotPrompt ─────────────────
// Prompt único pra qualquer tipo de shot (dialog / reaction / joint_action).
// Decide internamente entre:
//   - shot falado isolando lip-sync no speaker (com expressão visualAction como modificador),
//   - shot silencioso com ação visual específica (reação ou ação combinada),
//   - shot silencioso com ambos agindo juntos.
// Sempre injeta sceneContext + cameraDirection que vem do parser.

import type { ScriptShot, ScriptSpeaker } from "./script-types";

function sideOf(speaker: ScriptSpeaker): { speaker: "LEFT" | "RIGHT"; other: "LEFT" | "RIGHT" } {
  return speaker === "A"
    ? { speaker: "LEFT", other: "RIGHT" }
    : { speaker: "RIGHT", other: "LEFT" };
}

function dualSilenceLock(): string {
  return "AUDIO LOCK: the audio track is COMPLETELY SILENT — no voice, no speech, no music, no sound effects, no ambient sound. NO subtitles, NO captions, NO on-screen text. Both people stay quiet — neither person speaks, neither mouth opens to vocalize. They communicate only with body language and facial expression.";
}

export function buildScriptShotPrompt(args: {
  shot: ScriptShot;
  genderA: "male" | "female";
  genderB: "male" | "female";
  language?: NarratorLanguage;
  attempt?: number;
  personDescriptorA?: string;
  personDescriptorB?: string;
}): string {
  const { shot, genderA, genderB, language = "pt-BR", attempt = 0, personDescriptorA, personDescriptorB } = args;
  const lang = languageLabel(language);

  const sceneLine = shot.sceneContext
    ? `SCENE CONTEXT: ${shot.sceneContext}.`
    : "";
  const cameraLine = shot.cameraDirection
    ? `CAMERA: ${shot.cameraDirection}.`
    : "CAMERA: medium two-shot, both people fully visible in vertical 9:16 frame.";

  // ──────────────────────────── DIALOG ────────────────────────────────
  if (shot.kind === "dialog" && shot.speaker) {
    const sides = sideOf(shot.speaker);
    const speakerGender = shot.speaker === "A" ? genderA : genderB;
    const speakerDesc = shot.speaker === "A" ? personDescriptorA : personDescriptorB;
    const otherDesc = shot.speaker === "A" ? personDescriptorB : personDescriptorA;

    // Reforço progressivo de isolamento de boca conforme o attempt sobe.
    const isolationBlocks: string[] = [];
    isolationBlocks.push(
      `MOUTH ISOLATION LOCK — CRITICAL: Only ONE mouth may move — the mouth of the person on the ${sides.speaker}. The mouth of the person on the ${sides.other} is FROZEN CLOSED throughout. ZERO mouth movement, ZERO jaw movement on the ${sides.other} person.`,
    );
    if (attempt >= 1) {
      isolationBlocks.push(
        `LISTENER LOCK: The person on the ${sides.other} is LISTENING ONLY — closed neutral lips, natural blinks and small attentive head movements, mouth NEVER opens, NEVER vocalizes.`,
      );
      isolationBlocks.push(
        `SPEAKER LOCK: ONLY the person on the ${sides.speaker} speaks. Their mouth moves naturally in tight sync with the spoken words.`,
      );
    }
    if (attempt >= 2 && speakerDesc && otherDesc) {
      isolationBlocks.push(
        `IDENTITY LOCK: The ${speakerDesc} (${sides.speaker} side) speaks. The ${otherDesc} (${sides.other} side) stays SILENT with closed mouth.`,
      );
    }

    const visualActionLine = shot.visualAction
      ? `SPEAKER EXPRESSION: while the ${sides.speaker} person speaks, their face/body conveys: ${shot.visualAction}. The ${sides.other} person reacts subtly to this (matching emotional register) but stays silent.`
      : "";

    return [
      safetyPrefix(attempt),
      sceneLine,
      cameraLine,
      `Two people are visible in the same vertical frame (the source image shows both). The person on the ${sides.speaker} speaks DIRECTLY in this shot saying EXACTLY these words in ${lang} and NOTHING ELSE: "${shot.spokenText}". The person on the ${sides.other} stays silent and listens/reacts.`,
      visualActionLine,
      isolationBlocks.join(" "),
      pronunciationLock(shot.spokenText, language),
      voiceLock(speakerGender, language),
      audioNegativeLock(),
      visualPurityLock(),
      "Identity, hair, skin tone, clothing of BOTH people stay EXACTLY identical to the source image — change nothing except the speaker's lips, eyes and natural micro head movement required to speak, and the subtle reactive expression of the other person.",
      `Lips of the ${sides.speaker} person MUST be in tight sync with the spoken ${lang} words. The ${sides.other} person's lips MUST stay closed and motionless.`,
      "STRICTLY VERTICAL 9:16, 1080x1920, full-frame composition that keeps BOTH people clearly visible (unless the CAMERA line above explicitly requests a close-up of one of them).",
      `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks. ${forbiddenLanguagesClause(language)}`,
      audioNegativeLock(),
      visualPurityLock(),
      `FINAL PRONUNCIATION LOCK: every word of "${shot.spokenText}" must be spoken IN FULL, in ${lang}, audibly, by the ${sides.speaker} person only. NO word omitted, skipped or mumbled. The ${sides.other} person remains MUTE throughout. ${audioNegativeLock()}`,
    ].filter(Boolean).join(" ");
  }

  // ──────────────────────────── REACTION ──────────────────────────────
  if (shot.kind === "reaction" && shot.speaker) {
    const sides = sideOf(shot.speaker);
    const subjectDesc = shot.speaker === "A" ? personDescriptorA : personDescriptorB;
    return [
      safetyPrefix(attempt),
      sceneLine,
      cameraLine,
      `Two people are visible in the same vertical frame. The person on the ${sides.speaker}${subjectDesc ? ` (${subjectDesc})` : ""} performs this exact action: ${shot.visualAction}.`,
      `The person on the ${sides.other} is present in the frame and reacts subtly to the action of the ${sides.speaker} person (small head turn, attentive look, micro-expression matching the moment), but does NOT perform any major action.`,
      dualSilenceLock(),
      "Identity, hair, skin tone, clothing of BOTH people stay EXACTLY identical to the source image — only allow the natural micro-movements required by the described action.",
      "STRICTLY VERTICAL 9:16, 1080x1920, full-frame composition that keeps BOTH people visible (unless the CAMERA line above explicitly requests a close-up).",
      `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. ${forbiddenLanguagesClause(language)}`,
      visualPurityLock(),
    ].filter(Boolean).join(" ");
  }

  // ────────────────────────── JOINT ACTION ────────────────────────────
  // joint_action ou fallback (shot inválido)
  return [
    safetyPrefix(attempt),
    sceneLine,
    cameraLine,
    `Two people are visible in the same vertical frame. Both perform this combined action together: ${shot.visualAction || "they look at each other in a meaningful pause"}.`,
    dualSilenceLock(),
    "Identity, hair, skin tone, clothing of BOTH people stay EXACTLY identical to the source image — only allow the natural micro-movements required by the described action.",
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame composition that keeps BOTH people visible.",
    `STRICT NEGATIVE: no subtitles, no captions, no on-screen text, no watermarks, no logos. ${forbiddenLanguagesClause(language)}`,
    visualPurityLock(),
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
    visualPurityLock(),
    "Modest casual modern clothing. Neutral friendly facial expression. Soft natural daylight. Plain minimalist indoor background, slightly out of focus.",
    `Lips MUST be in tight sync with the spoken ${lang} words. No camera movement other than handheld micro-shake.`,
    "STRICTLY VERTICAL 9:16, 1080x1920, full-frame portrait, no letterboxing, no pillarboxing, no black bars.",
    `NO subtitles, NO captions, NO on-screen text, NO watermarks. ${forbiddenLanguagesClause(language)}`,
    `FINAL PRONUNCIATION LOCK: every word of "${text}" must be spoken IN FULL, in ${lang}, audibly and correctly. NO word may be omitted, skipped, shortened, or mumbled. ${audioNegativeLock()} ${visualPurityLock()}`,
  ].join(" ");
}
