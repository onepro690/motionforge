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
    "  Step 1 — Read the `text` of the segment. Identify 1-2 CONCRETE NOUNS/VERBS/IMAGES inside it (e.g. 'heart', 'path', 'sign', 'return', 'pain', 'luck', 'fate', 'message', 'truth').",
    "  Step 2 — Build a literal OR metaphorical visual scene of those specific concepts.",
    "  Step 3 — Apply the MYSTICAL AESTHETIC FILTER on top (color + light + atmosphere).",
    "  Step 4 — Add a dynamic, revealing camera move.",
    "",
    "EXAMPLES of text → scene mapping (the text excerpt is shown in English here, but works the same for any language):",
    "  • Text mentions 'love that never ends / amor que não termina' → close-up of two hands almost touching across a candlelit table, slow push-in, golden particles drifting between them, deep violet background, anamorphic flares.",
    "  • Text mentions 'decision / choice / path / caminho' → fork in a misty cosmic road at twilight, zodiac constellations forming a sky-map above, slow crane reveal, indigo and gold light, swirling fog.",
    "  • Text mentions 'sign / message / aviso' → an old envelope on dark velvet glowing from within, wax seal cracking open, golden light bursting out, snap-zoom into the seal.",
    "  • Text mentions 'fate / destiny / future / destino' → three tarot cards face down on dark velvet, middle card flipping in slow motion revealing a glowing zodiac symbol, candles flickering, push-in.",
    "  • Text mentions a specific person ('she / he / they / ela / ele') → silhouette of a figure walking through violet fog at dusk, slow orbit camera revealing them turning slightly, distant city lights as bokeh.",
    "  • Text mentions 'time / now / past / tempo' → ornate antique pocket watch suspended in cosmic space, hands spinning backward, gold dust trails, dolly-zoom.",
    "  • Text mentions 'truth / revelation / verdade' → an eye slowly opening in extreme close-up, iris reflecting a galaxy, push-in until pupil fills the frame.",
    "  • Text mentions 'heart / feeling / coração' → glowing red-gold heart shape forming from particles in the dark, slow rotation, soft volumetric rays.",
    "  • Text mentions 'soulmate / twin flame / alma gêmea' → two flame silhouettes orbiting each other in cosmic space, sparks merging, slow zoom out revealing constellation forming around them.",
    "  • Text mentions 'energy / aura / vibration' → swirling iridescent aura around an empty silhouette, prismatic light fragments, ethereal slow rotation, particle trails.",
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

// Fallback: divide a copy em N partes de tamanho similar, quebrando em
// fronteira de palavra. Garante que NENHUMA palavra se perca.
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

function defaultVisualPrompt(_text: string, vibe?: string): string {
  const style = vibe?.trim() || "cinematic premium B-roll";
  return `Vertical 9:16 ${style}, dynamic camera movement, rich color grading, no people speaking, no text on screen, no subtitles, ambient documentary tone.`;
}

export const NARRATOR_SECONDS_PER_TAKE = SECONDS_PER_TAKE;
