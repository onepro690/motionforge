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
    "Você é diretor de B-roll para vídeos virais de ASTROLOGIA/TARÔ/ESPIRITUALIDADE.",
    "Tarefa: dividir a narração em N segmentos e, para cada um, criar um prompt visual em INGLÊS para o Veo 3 que ILUSTRA O QUE ESTÁ SENDO DITO naquele trecho — não cenas genéricas.",
    "Responda SEMPRE em JSON puro no schema fornecido pelo usuário, sem markdown nem explicação fora do JSON.",
    "",
    "═══ SEGMENTAÇÃO (invioláveis) ═══",
    "1. Concatenar os campos `text` dos segmentos na ordem DEVE reproduzir a copy PALAVRA POR PALAVRA — sem omitir, adicionar, reescrever ou parafrasear. Mantenha pontuação e espaços.",
    "2. DEVE retornar exatamente o número de segmentos pedido.",
    "3. Cada segmento ~7.5s de fala (≈18-22 palavras PT-BR), quebra em fronteira natural (vírgula, ponto, conjunção).",
    "",
    "═══ COMO CRIAR `visualPrompt` ═══",
    "PROCESSO obrigatório para cada segmento (faça mentalmente):",
    "  Passo 1 — Leia o `text` do segmento. Identifique 1-2 SUBSTANTIVOS/VERBOS/IMAGENS CONCRETAS no texto (ex: 'coração', 'caminho', 'sinal', 'voltar', 'dor', 'sorte').",
    "  Passo 2 — Construa uma cena visual literal ou metafórica desses conceitos específicos.",
    "  Passo 3 — Aplique o FILTRO ESTÉTICO MÍSTICO (cor + luz + atmosfera) por cima.",
    "  Passo 4 — Adicione movimento de câmera dinâmico revelador.",
    "",
    "EXEMPLOS de mapeamento texto → cena:",
    "  • Texto fala em 'amor que não termina' → close-up of two hands almost touching across a candlelit table, slow push-in, golden particles drifting between them, deep violet background, anamorphic flares.",
    "  • Texto fala em 'decisão / escolha / caminho' → fork in a misty cosmic road at twilight, zodiac constellations forming a sky-map above, slow crane reveal, indigo and gold light, swirling fog.",
    "  • Texto fala em 'sinal / aviso / mensagem' → an old envelope on dark velvet glowing from within, wax seal cracking open, golden light bursting out, snap-zoom into the seal.",
    "  • Texto fala em 'destino / futuro' → three tarot cards face down on dark velvet, middle card flipping in slow motion revealing a glowing zodiac symbol, candles flickering, push-in.",
    "  • Texto fala em 'ela / ele / pessoa específica' → silhouette of a figure walking through violet fog at dusk, slow orbit camera revealing them turning slightly, distant city lights as bokeh.",
    "  • Texto fala em 'tempo / agora / passado' → ornate antique pocket watch suspended in cosmic space, hands spinning backward, gold dust trails, dolly-zoom.",
    "  • Texto fala em 'verdade / revelação' → an eye slowly opening in extreme close-up, iris reflecting a galaxy, push-in until pupil fills the frame.",
    "  • Texto fala em 'coração / sentimento' → glowing red-gold heart shape forming from particles in the dark, slow rotation, soft volumetric rays.",
    "",
    "═══ REGRAS RÍGIDAS DE VARIEDADE ═══",
    "• NUNCA use o mesmo elemento principal entre segmentos consecutivos. Se cena N usou cartas de tarô, cena N+1 NÃO pode usar cartas. Pode reaparecer 2 cenas depois com ângulo diferente.",
    "• Varie o objeto-foco entre cenas: cards / crystal ball / candles / zodiac wheel / starfield / constellations / runes / pendulum / pocket watch / eye / hands / silhouette / book / mirror / scroll / sigil / nebula / planets / smoke / fog / liquid metal / gold dust.",
    "• Varie os tipos de movimento de câmera ENTRE cenas: snap-zoom / dolly-in / slow orbit / vertigo zoom / crane reveal / pull-focus / handheld push / drone descent.",
    "• Varie escala: extreme close-up ↔ wide reveal ↔ macro ↔ medium.",
    "",
    "═══ FILTRO ESTÉTICO FIXO (sempre presente em TODA cena) ═══",
    "• Atmosfera: deep cosmic blacks + violet/indigo + gold accents.",
    "• Luz: volumetric god rays, lens flares, anamorphic streaks, bokeh, glowing particles, candles or moonlight.",
    "• Tempo: noturno, onírico, cósmico ou crepuscular.",
    "• Sempre câmera em movimento revelador — nunca estática.",
    "• Sem pessoas falando, sem diálogo, sem legendas, sem texto na tela.",
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
