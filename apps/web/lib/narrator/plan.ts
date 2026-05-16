// Narrator pipeline: divide copy em segmentos de ~7.5s e gera um prompt
// visual cinematográfico (B-roll, sem fala) pra cada segmento.
//
// Usa GPT-4o-mini num único call pra fazer as duas coisas, garantindo que
// `text` de cada segmento seja um trecho contíguo da copy original (concat dos
// `text` reproduz a copy inteira). N é calculado pelo caller a partir da
// duração real do MP3 do TTS.

const SECONDS_PER_TAKE = 7.5; // Veo gera 8s; deixa 0.5s buffer

export interface NarratorSegment {
  text: string;
  visualPrompt: string;
}

export function computeTakeCount(narrationSeconds: number): number {
  if (!Number.isFinite(narrationSeconds) || narrationSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(narrationSeconds / SECONDS_PER_TAKE));
}

interface PlanArgs {
  copy: string;
  takeCount: number;
  vibe?: string;
}

export async function planNarratorSegments({ copy, takeCount, vibe }: PlanArgs): Promise<NarratorSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const styleHint = vibe?.trim()
    ? `Estilo extra solicitado pelo usuário: ${vibe.trim()}.`
    : "";

  const system = [
    "You are a B-roll director for viral ASTROLOGY/TAROT/SPIRITUALITY videos.",
    "Task: split the narration copy into N segments and, for each segment, create a visual prompt (always in ENGLISH) for Veo 3 that ILLUSTRATES WHAT IS BEING SAID in that exact segment — never generic scenes.",
    "The copy may be in any language (Portuguese, English, Spanish, etc). Detect the language naturally and read the meaning as a native speaker would. The `text` field MUST stay in the original language of the copy. The `visualPrompt` MUST always be in English.",
    "Always respond as PURE JSON matching the schema provided by the user — no markdown, no explanation outside JSON.",
    "",
    "═══ SEGMENTATION (strict) ═══",
    "1. Concatenating the `text` fields of all segments in order MUST reproduce the original copy WORD-FOR-WORD — do not omit, add, rephrase or paraphrase anything. Keep punctuation and spaces.",
    "2. You MUST return exactly the requested number of segments.",
    "3. Each segment ~7.5s of speech (≈18-22 words), break at natural boundaries (comma, period, conjunction).",
    "",
    "═══ HOW TO CREATE `visualPrompt` ═══",
    "Mandatory mental process for each segment:",
    "  Step 1 — Read the `text` literally. Identify the EXACT ACTION OR INSTRUCTION the narrator is giving (e.g. 'think of a person', 'whisper a name three times', 'see the face of your soulmate', 'comment a word', 'close your eyes', 'remember a moment').",
    "  Step 2 — Identify the EMOTIONAL BEAT: curiosity / suspense / revelation / nostalgia / promise / warning / build-up / payoff.",
    "  Step 3 — Build a visual scene that DIRECTLY illustrates that action and that beat. The scene should make a viewer instantly understand what the narrator is talking about.",
    "  Step 4 — Apply the MYSTICAL AESTHETIC FILTER on top (color + light + atmosphere) — never replace the literal scene with a generic mystical one.",
    "  Step 5 — Add a dynamic, revealing camera move that supports the emotion.",
    "",
    "FUNDAMENTAL: the visual must FOLLOW THE COPY LITERALLY. If the narrator says 'whisper the name three times', the scene MUST show whispering lips or the act of whispering — not generic tarot cards. If the narrator says 'I'll show you his face', the scene MUST involve a face appearing/being revealed — not zodiac wheels.",
    "",
    "EXAMPLES of literal action → scene mapping (works for any language):",
    "  • 'Think of the first man who comes to your mind / Pensa no primeiro homem que vem na sua mente' → soft-focus dreamlike memory flashbacks of a male silhouette at sunset, golden bokeh, then the image dissolves into a swirling violet smoke; slow push-in into a glowing astrology constellation that morphs into the silhouette's outline; nostalgic, memory-like.",
    "  • 'Whisper his name three times softly / Fala o nome dele três vezes bem baixinho' → extreme macro close-up of feminine lips whispering in candlelight, breath visible as warm vapor, golden particles drifting from the breath, deep violet background, intimate and secret atmosphere, slow push-in.",
    "  • 'I'll show you his face / Te mostrar o rosto dele' → a tall ornate astrology mirror in a dark room, surface rippling like liquid mercury, a blurry realistic male face slowly emerging from inside the mirror, half-hidden by violet smoke, golden light from candles around it; suspenseful slow push-in, vertigo zoom into the mirror as the face starts to focus.",
    "  • 'Comment 'soul' below / Comenta alma aqui embaixo' → a glowing word forming itself letter by letter in cosmic dust against a starry night sky, then dissolving into rising golden sparks; intimate magical reveal.",
    "  • 'Close your eyes / Feche os olhos' → extreme close-up of an eye slowly closing, lashes catching golden light, then a galaxy reflected on the eyelid; smooth dolly-in.",
    "  • 'Remember the last time you saw him / Lembra da última vez que o viu' → blurred dreamlike flashback of a backlit doorway, a silhouette walking away into golden light, dust particles, slow handheld push.",
    "  • 'Love that never ends / Amor que não termina' → close-up of two hands almost touching across a candlelit table, slow push-in, golden particles drifting between them, deep violet background, anamorphic flares.",
    "  • 'Decision / choice / path / caminho' → fork in a misty cosmic road at twilight, zodiac constellations forming a sky-map above, slow crane reveal, indigo and gold light, swirling fog.",
    "  • 'Sign / message / aviso' → an old envelope on dark velvet glowing from within, wax seal cracking open, golden light bursting out, snap-zoom into the seal.",
    "  • 'Fate / destiny / future / destino' → three tarot cards face down on dark velvet, middle card flipping in slow motion revealing a glowing zodiac symbol, candles flickering, push-in.",
    "  • 'Truth / revelation / verdade' → an eye slowly opening in extreme close-up, iris reflecting a galaxy, push-in until pupil fills the frame.",
    "  • 'Heart / feeling / coração' → glowing red-gold heart shape forming from particles in the dark, slow rotation, soft volumetric rays.",
    "  • 'Soulmate / twin flame / alma gêmea' → two flame silhouettes orbiting each other in cosmic space, sparks merging, slow zoom out revealing constellation forming around them.",
    "  • 'Energy / aura / vibration' → swirling iridescent aura around an empty silhouette, prismatic light fragments, ethereal slow rotation, particle trails.",
    "",
    "═══ TYPES OF SCENES YOU CAN USE FREELY (combine with literal action) ═══",
    "When the copy describes an action involving a person, you CAN show humans (silhouettes, hands, lips, eyes, faces emerging from mirrors/smoke/water) — they should NOT be talking, but they CAN be doing the action. Examples: whispering lips, eyes opening/closing, hands holding cards or candles, a blurred face emerging from a mystical surface, a silhouette walking through fog, fingers tracing constellations on a window, a body floating in cosmic water.",
    "",
    "═══ STRICT VARIETY RULES ═══",
    "• NEVER reuse the same main element between consecutive segments. If scene N used tarot cards, scene N+1 must NOT use tarot cards. It can reappear 2+ scenes later with a different angle.",
    "• Vary the focus object between scenes: cards / crystal ball / candles / zodiac wheel / starfield / constellations / runes / pendulum / pocket watch / eye / hands / silhouette / book / mirror / scroll / sigil / nebula / planets / smoke / fog / liquid metal / gold dust / aura / flames / mountain / ocean / mirror reflection / doorway / staircase / key / locket / feather / butterfly / crow / wolf / moth.",
    "• Vary camera move types between scenes: snap-zoom / dolly-in / slow orbit / vertigo zoom / crane reveal / pull-focus / handheld push / drone descent / arc shot / whip pan.",
    "• Vary scale: extreme close-up ↔ wide reveal ↔ macro ↔ medium.",
    "",
    "═══ FIXED AESTHETIC FILTER (always present in EVERY scene) ═══",
    "• Atmosphere: deep cosmic blacks + violet/indigo + gold accents.",
    "• Light: volumetric god rays, lens flares, anamorphic streaks, bokeh, glowing particles, candles or moonlight.",
    "• Time of day: nocturnal, dreamlike, cosmic or twilight.",
    "• Camera always in revealing motion — never static.",
    "• No people speaking, no dialogue, no subtitles, no on-screen text.",
    "• Vertical 9:16, sharp focus, dramatic high-contrast color grading.",
    "",
    styleHint,
  ].filter(Boolean).join("\n");

  const user = JSON.stringify({
    copy,
    takeCount,
    outputSchema: {
      segments: [{ text: "string (trecho contíguo exato da copy)", visualPrompt: "string (em inglês, B-roll, sem fala)" }],
    },
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.95,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI plan error: ${res.status} ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { segments?: NarratorSegment[] };
  const segments = parsed.segments ?? [];

  // Validação: se LLM perdeu palavras, faz fallback determinístico
  const reconstructed = segments.map((s) => s.text ?? "").join("").replace(/\s+/g, " ").trim();
  const expected = copy.replace(/\s+/g, " ").trim();
  if (segments.length !== takeCount || reconstructed.length < expected.length * 0.95) {
    return splitCopyDeterministic(copy, takeCount).map((text, i) => ({
      text,
      visualPrompt: segments[i]?.visualPrompt ?? defaultVisualPrompt(text, vibe),
    }));
  }

  return segments;
}

// Fallback antigo: divide por chars em fronteira de palavra. Mantido pra
// retrocompatibilidade do `planNarratorSegments` quando o LLM retorna lixo.
function splitCopyDeterministic(copy: string, n: number): string[] {
  const words = copy.split(/(\s+)/); // mantém os espaços
  const totalChars = copy.length;
  const targetPerSegment = totalChars / n;

  const out: string[] = [];
  let buf = "";
  let acc = 0;
  for (const w of words) {
    buf += w;
    acc += w.length;
    if (out.length < n - 1 && acc >= targetPerSegment) {
      out.push(buf);
      buf = "";
      acc = 0;
    }
  }
  if (buf.length > 0) {
    if (out.length < n) out.push(buf);
    else out[out.length - 1] += buf;
  }
  while (out.length < n) out.push("");
  return out;
}

// Split por fim de oração (`.`, `!`, `?`). Agrupa sentenças em buckets até
// cada bucket aproximar de `targetTakeCount` em char count balanceado. Nunca
// quebra dentro de uma frase — cada take começa e termina em fronteira de
// pontuação forte.
//
// Trade-off: o número de buckets PODE diferir de `targetTakeCount`. Se a copy
// tem poucas frases (ex 3 frases longas pra 5 takes pedidos), devolve 3 takes.
// Se tem muitas frases curtas, agrupa pra chegar perto do target.
function splitCopyBySentences(copy: string, targetTakeCount: number): string[] {
  // Captura cada sentença com sua pontuação final (mantém aspas/parênteses
  // de fechamento depois do ponto). Trecho final sem pontuação vira sentença.
  const sentenceRegex = /[^.!?\n]+[.!?]+["”'’)\]]*\s*|[^.!?\n]+(?:\n|$)/g;
  const sentences = (copy.match(sentenceRegex) ?? [copy])
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [copy.trim()];
  if (sentences.length <= targetTakeCount) {
    return sentences;
  }

  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const targetPerBucket = totalChars / targetTakeCount;

  const buckets: string[] = [];
  let current = "";
  let currentChars = 0;

  for (const s of sentences) {
    const remainingTakes = targetTakeCount - buckets.length;
    const wouldBeChars = currentChars + s.length + (current ? 1 : 0);
    // Fecha o bucket atual quando ele já ultrapassou o target E ainda há mais
    // takes a preencher (last bucket recebe tudo que sobrar).
    if (current && wouldBeChars > targetPerBucket * 1.4 && remainingTakes > 1) {
      buckets.push(current);
      current = s;
      currentChars = s.length;
    } else {
      current = current ? `${current} ${s}` : s;
      currentChars = wouldBeChars;
    }
  }
  if (current) buckets.push(current);

  return buckets;
}

function defaultVisualPrompt(_text: string, vibe?: string): string {
  const style = vibe?.trim() || "cinematic premium B-roll";
  return `Vertical 9:16 ${style}, dynamic camera movement, rich color grading, no people speaking, no text on screen, no subtitles, ambient documentary tone.`;
}

// Modo avatar: só dividimos a copy em N segmentos contíguos. O "visual" é a
// foto do avatar (reusada em todos os takes), portanto não precisamos de
// visualPrompt cinematográfico — o prompt do Veo é construído no caller a
// partir do `text` + voice/gender/audioMode.
//
// Split é por fim de oração: cada take termina em ponto/exclamação/interrogação,
// nunca corta no meio de uma frase. Pode resultar em menos takes que o pedido
// (quando copy tem poucas frases longas) — está OK, prefere coerência narrativa.
export function planAvatarSegments(copy: string, takeCount: number): NarratorSegment[] {
  return splitCopyBySentences(copy, takeCount).map((text) => ({
    text,
    visualPrompt: "",
  }));
}

// ─── MODO MISTURADO ────────────────────────────────────────────────────────
// LLM classifica cada segmento em "avatar" | "broll" | "avatar_cutout" e
// gera, quando necessário, descrição do cenário B-roll ou do background pra
// cutout. Resultado: roteiro completo pra o pipeline de geração.

export type MixedSegmentStyle = "avatar" | "broll" | "avatar_cutout";

export interface MixedSegment {
  text: string;
  style: MixedSegmentStyle;
  // Visual prompt cinematográfico — usado pra style="broll".
  visualPrompt: string;
  // Descrição do cenário pra style="avatar_cutout" (Nano Banana edita o fundo
  // da foto do avatar pra esse cenário).
  backgroundDescription: string;
}

interface PlanMixedArgs {
  copy: string;
  takeCount: number;
  language: "pt-BR" | "en" | "es";
}

export async function planMixedSegments({ copy, takeCount, language }: PlanMixedArgs): Promise<MixedSegment[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Fallback determinístico: alterna avatar/broll, sem cutout
    return splitCopyBySentences(copy, takeCount).map((text, i) => ({
      text,
      style: (i % 2 === 0 ? "avatar" : "broll") as MixedSegmentStyle,
      visualPrompt: defaultVisualPrompt(text, undefined),
      backgroundDescription: "soft minimalist indoor scene with warm natural light",
    }));
  }

  const langName = language === "pt-BR" ? "Brazilian Portuguese" : language === "es" ? "Spanish" : "English";

  const system = [
    "You are a UGC video director for short-form content (TikTok/Reels/Shorts).",
    "Task: split a narration copy into N segments AND for EACH segment, choose ONE of 3 visual styles, and generate visual prompts THAT LITERALLY ILLUSTRATE what is being said in THAT specific segment.",
    "",
    "═══ NON-NEGOTIABLE RULE ═══",
    "The visualPrompt / backgroundDescription MUST illustrate the LITERAL MEANING of the segment text — like a director would show on screen exactly what the narrator is talking about.",
    "Read each segment text and ask: 'What concrete image directly represents what is being said here?' Then describe THAT image.",
    "NEVER produce a generic mood scene that has nothing to do with the words. NEVER reuse the same scene across segments. NEVER default to 'mystical' / 'cosmic' / 'cinematic abstract' if the text is concrete.",
    "",
    "═══ THE 3 STYLES ═══",
    "1. 'avatar' — the creator speaks DIRECTLY to camera in selfie framing. Best for: personal claims, opinions, intimate confessions, direct address ('I'll tell you', 'listen', 'I know how it feels').",
    "2. 'broll' — a real photographic shot WITHOUT any person, that LITERALLY shows what the segment is saying. Best for: concrete nouns, scenes, objects, places, actions described in the text. NO people in the shot.",
    "3. 'avatar_cutout' — the same creator visible in a NEW realistic background that supports the words. Best for: 'imagine yourself doing X' moments where placing the creator in a scene reinforces the message.",
    "",
    "═══ RULES ═══",
    "1. Concatenating the `text` fields in order must REPRODUCE the original copy WORD-FOR-WORD — keep punctuation and spaces. NO additions, NO removals, NO paraphrasing.",
    "2. Return EXACTLY the requested number of segments. Each ~7.5s spoken (≈18-22 words). Break at . ! ? ;.",
    "3. Mix styles. Avoid 3+ consecutive of the same style. Use 'broll' generously when the text describes something visual or concrete. Use 'avatar_cutout' for emphasis.",
    "4. `text` stays in the original language. `visualPrompt` / `backgroundDescription` are ALWAYS in English (Veo prompt language).",
    "",
    "═══ visualPrompt (style='broll' only) — ILLUSTRATE THE TEXT LITERALLY ═══",
    "Format: subject + action + setting + lighting + camera move. ~30-50 words. Cinematic photorealistic. NO people speaking. NO text overlays.",
    "",
    "CONCRETE EXAMPLES of LITERAL illustration (study how each visual MIRRORS the segment text):",
    "- Text: 'He suddenly went quiet on social media.'",
    "  → 'Smartphone lying face-up on a wooden desk, screen showing an empty social media feed with no new notifications, the screen slowly dims to standby in a softly lit room, slow push-in on the dark screen, melancholic mood lighting.'",
    "- Text: 'You will wake up tomorrow and everything will feel different.'",
    "  → 'Soft morning sunlight slowly creeping across white linen bed sheets at dawn, an empty rumpled pillow next to a window with curtains gently moving in the breeze, slow gentle pan from the pillow to the bright window, peaceful warm tones.'",
    "- Text: 'Money is sitting right in front of you, and you cannot see it.'",
    "  → 'Stack of dollar bills resting on a sunlit wooden table next to a closed laptop and a coffee mug, a hand reaches in from off-frame, hovers over the laptop but ignores the money, soft daylight from window, shallow depth of field on the bills.'",
    "- Text: 'The same routine, every single day.'",
    "  → 'Time-lapse perspective of a person\\'s legs walking through the exact same crosswalk repeatedly at the same angle, morning sun casting identical shadows, urban setting, locked-off frame, grey overcast tones, the loop feeling.'",
    "- Text: 'Just one decision can change everything.'",
    "  → 'Close-up of a single finger about to press an unmarked elevator button glowing softly in the dark, dramatic low-key lighting, anticipatory shallow focus on the fingertip approaching the button, tension building.'",
    "- Text: 'Three signs that he\\'s hiding how he feels.'",
    "  → 'Three small numbered cards (1, 2, 3) face-down on a dark velvet surface, the first card slowly turning over by itself, warm spot lighting from above, slow reveal, intimate tabletop shot.'",
    "",
    "═══ backgroundDescription (style='avatar_cutout' only) ═══",
    "Describe ONLY the background that will surround the creator (do NOT describe the creator themselves). Realistic scene that supports the segment. ~15-30 words. Slightly out of focus.",
    "Example for 'imagine standing at the crossroads of your life': 'wide open desert highway at golden hour stretching into the horizon, soft warm light, distant mountains, dust particles in the air, shallow depth of field'.",
    "",
    "═══ style='avatar' ═══",
    "Leave visualPrompt and backgroundDescription as EMPTY STRINGS. Pipeline uses the avatar photo as-is.",
    "",
    "═══ OUTPUT SCHEMA (strict JSON) ═══",
    `{"segments": [{"text": "...", "style": "avatar"|"broll"|"avatar_cutout", "visualPrompt": "...", "backgroundDescription": "..."}, ...]}`,
    `Copy language for the text field: ${langName}.`,
  ].join("\n");

  const user = JSON.stringify({ copy, takeCount });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI plan-mixed error: ${res.status} ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { segments?: Array<Partial<MixedSegment>> };
  const segments = parsed.segments ?? [];

  // Validação: se concat dos texts não bate, faz fallback determinístico
  const reconstructed = segments.map((s) => s.text ?? "").join("").replace(/\s+/g, " ").trim();
  const expected = copy.replace(/\s+/g, " ").trim();
  if (segments.length === 0 || reconstructed.length < expected.length * 0.9) {
    return splitCopyBySentences(copy, takeCount).map((text, i) => ({
      text,
      style: (i % 2 === 0 ? "avatar" : "broll") as MixedSegmentStyle,
      visualPrompt: defaultVisualPrompt(text, undefined),
      backgroundDescription: "soft minimalist indoor scene with warm natural light",
    }));
  }

  return segments.map((s) => ({
    text: s.text ?? "",
    style: (s.style ?? "avatar") as MixedSegmentStyle,
    visualPrompt: s.visualPrompt ?? "",
    backgroundDescription: s.backgroundDescription ?? "",
  }));
}

export const NARRATOR_SECONDS_PER_TAKE = SECONDS_PER_TAKE;

// ─── MODO CONVERSATION ────────────────────────────────────────────────────
// Parser puro de tags [A]/[B] vive em ./parse-conversation (client-safe).
// Aqui só o planner que precisa de SECONDS_PER_TAKE e splitCopyBySentences.

import { parseConversationTurns, type ConversationTurn, type Speaker } from "./parse-conversation";
export { parseConversationTurns } from "./parse-conversation";
export type { ConversationTurn, Speaker } from "./parse-conversation";

export interface ConversationSegment {
  text: string;
  speaker: Speaker;
  visualPrompt: string;
}

// Quebra um turno longo em sub-segmentos preservando speaker, reusando
// splitCopyBySentences pra cortar em fronteira de frase. Garante que cada
// sub-segmento caiba em ~7.5s do Veo.
function splitTurnIfNeeded(turn: ConversationTurn): ConversationTurn[] {
  const wordsPerSecond = 2.8;
  const words = turn.text.split(/\s+/).filter(Boolean).length;
  const estimated = words / wordsPerSecond;
  if (estimated <= SECONDS_PER_TAKE) return [turn];
  const subCount = Math.ceil(estimated / SECONDS_PER_TAKE);
  const sub = splitCopyBySentences(turn.text, subCount);
  return sub.map((text) => ({ speaker: turn.speaker, text }));
}

export function planConversationSegments(copy: string): ConversationSegment[] {
  const turns = parseConversationTurns(copy);
  const out: ConversationSegment[] = [];
  for (const t of turns) {
    for (const sub of splitTurnIfNeeded(t)) {
      out.push({ text: sub.text, speaker: sub.speaker, visualPrompt: "" });
    }
  }
  return out;
}
