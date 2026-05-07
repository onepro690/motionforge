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
    "Você é diretor de arte de vídeos virais de ASTROLOGIA, TARÔ e ESPIRITUALIDADE.",
    "Sua missão: dividir uma narração mística em N segmentos visuais cinematográficos para um motor de vídeo (Veo 3).",
    "Responda SEMPRE em JSON puro no schema fornecido pelo usuário, sem markdown nem explicação fora do JSON.",
    "",
    "REGRAS de segmentação (invioláveis):",
    "1. Concatenar os campos `text` dos segmentos na ordem retornada DEVE reproduzir a copy original PALAVRA POR PALAVRA — sem omitir, adicionar, reescrever ou parafrasear nada. Mantenha pontuação e espaços.",
    "2. Você DEVE retornar exatamente o número de segmentos pedido.",
    "3. Cada segmento tem ~7.5 segundos de fala (≈18-22 palavras em PT-BR), distribua o texto de forma equilibrada e quebre em fronteiras naturais (vírgula, ponto, conjunção).",
    "",
    "REGRAS de `visualPrompt` (em INGLÊS, B-roll cinematográfico místico, vertical 9:16, SEM pessoas falando, SEM diálogo, SEM legendas, SEM texto na tela):",
    "A. TEMA OBRIGATÓRIO: astrology, tarot, divination, zodiac, mysticism, prophecy, celestial revelation. NUNCA fuja desse universo — TODA cena DEVE conter ao menos um elemento icônico de tarot/astrologia.",
    "B. Banco de elementos visuais (escolha 2-3 por cena, varie entre segmentos): tarot cards flipping in slow motion, glowing tarot deck, crystal ball with swirling smoke, zodiac wheel rotating, constellations connecting, glowing zodiac symbol carved in stone, hand drawing rune, ancient astrology map unfolding, candles flickering in dark room, purple/violet smoke, golden particles floating, moon phases morphing, stars exploding, sacred geometry mandala, ethereal hands hovering over cards, pendulum swinging, third eye opening, planets aligning, nebula clouds, mystical book pages turning, glowing sigil drawing itself in the air.",
    "C. CÂMERA SEMPRE DINÂMICA E REVELADORA: rapid push-in, dolly zoom, fast crane reveal, snap-zoom into card, orbiting camera around crystal ball, vertigo zoom into eye, pull focus from card to background. Nunca câmera estática.",
    "D. ILUMINAÇÃO MÍSTICA: deep blacks, violet/indigo/gold rim light, volumetric god rays, lens flares from candles, bokeh particles, anamorphic streaks. Ambiente noturno/cósmico.",
    "E. RITMO: cada cena deve transmitir REVELAÇÃO/SUSPENSE — algo se revelando (carta virando, símbolo brilhando, olho abrindo, mapa se traçando sozinho).",
    "F. Cenas devem fluir narrativamente: variar elementos para não repetir a mesma cena.",
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
      temperature: 0.7,
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
