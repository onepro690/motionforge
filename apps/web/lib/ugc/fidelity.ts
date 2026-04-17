// STRICT REFERENCE FIDELITY
// ──────────────────────────────────────────────────────────────────────────
// Este módulo centraliza a lógica de REENACTMENT (reencenação exata do vídeo
// de referência). Em vez de gerar um vídeo "parecido", o pipeline reproduz
// o original o mais fielmente possível, trocando APENAS a identidade da
// pessoa pelo avatar escolhido.
//
// Três pilares:
// 1. TAKE_SPEC: a "partitura" do take — timestamp, ação, visual, fala, falante.
//    Cada take é uma fatia literal do vídeo original, não uma interpretação.
// 2. Prompts reenactment-style: instruem o modelo de vídeo a REPRODUZIR,
//    não a criar. A única variável liberada é a identidade da pessoa.
// 3. Validação pós-gen: Gemini pontua cada take contra a fatia de referência.
//    Scores críticos abaixo do threshold → regenera uma vez.

import type { SceneBreakdown, TranscriptSegment, VoiceStyle } from "./reference-video";

// ── TAKE_SPEC ────────────────────────────────────────────────────────────
// A especificação rígida de um take. Preserva EXATAMENTE o trecho do vídeo
// original ao qual corresponde. Nada é reinterpretado aqui.
export interface TakeSpec {
  takeIndex: number;              // 0-based
  takeKey: string;                // "take1", "take2", ...
  startTime: number;              // segundos desde o início do vídeo de referência
  endTime: number;                // segundos
  duration: number;               // endTime - startTime
  // ── Visual (do Gemini scene breakdown) ──────────────────────────────────
  exactAction: string;            // ação EXATA no trecho (ex: "segura o vestido rosa")
  exactVisuals: string;           // visual DETALHADO (cor, pose, objetos, fundo)
  exactFraming: string | null;    // enquadramento inferido (close, wide, selfie)
  exactBackground: string | null; // descrição literal do fundo
  exactWardrobe: string | null;   // roupa visível no take
  peopleCount: number;            // número de pessoas visíveis
  // ── Áudio ──────────────────────────────────────────────────────────────
  exactSpeechText: string;        // transcript literal do trecho (Whisper). "" se silent.
  exactSpeaker: "none" | "solo" | "group_unison" | "multiple_alternating";
  exactEmotion: string | null;    // emoção dominante (do voiceStyle do Gemini)
  // ── Transição ──────────────────────────────────────────────────────────
  transitionIn: "hard_cut" | "continuous" | "none";
  transitionOut: "hard_cut" | "continuous" | "none";
}

// Constrói a lista de TAKE_SPECs a partir das cenas Gemini + segmentos Whisper.
// Regra principal: o vídeo de referência é a fonte da verdade. Cada take
// corresponde literalmente a um trecho do original.
export function buildTakeSpecs(params: {
  takeCount: number;
  scenes: SceneBreakdown[] | null;
  transcriptSegments: TranscriptSegment[] | null;
  takeScripts: Record<string, string>;
  referenceDuration: number | null;
  voiceStyle: VoiceStyle | null;
  hasNarration: boolean;
  transitionMode: "continuous" | "hard_cuts";
}): TakeSpec[] {
  const {
    takeCount,
    scenes,
    takeScripts,
    referenceDuration,
    voiceStyle,
    hasNarration,
    transitionMode,
  } = params;

  const specs: TakeSpec[] = [];
  const refDur = referenceDuration && referenceDuration > 0 ? referenceDuration : takeCount * 8;

  for (let i = 0; i < takeCount; i++) {
    const takeKey = `take${i + 1}`;
    const sceneForTake = scenes?.[i];
    const script = takeScripts[takeKey]?.trim() ?? "";

    // Deriva startTime/endTime do timeRange do Gemini ("0-3s") se disponível,
    // senão divide a duração total igualmente entre os takes.
    let startTime: number;
    let endTime: number;
    if (sceneForTake?.timeRange) {
      const parsed = parseTimeRange(sceneForTake.timeRange);
      startTime = parsed.start;
      endTime = parsed.end;
    } else {
      const per = refDur / takeCount;
      startTime = i * per;
      endTime = (i + 1) * per;
    }

    // Speaker mode: Gemini → fallback "solo" se tem fala, "none" se não.
    const speaker: TakeSpec["exactSpeaker"] = sceneForTake?.speakerMode ??
      (script.length > 0 ? "solo" : "none");

    const transitionIn: TakeSpec["transitionIn"] = i === 0
      ? "none"
      : transitionMode === "continuous" && hasNarration
        ? "continuous"
        : "hard_cut";
    const transitionOut: TakeSpec["transitionOut"] = i === takeCount - 1
      ? "none"
      : transitionMode === "continuous" && hasNarration
        ? "continuous"
        : "hard_cut";

    // Framing e background vêm do campo "visuals" do Gemini. Tentamos inferir
    // framing por keywords; se falhar, deixa null e o modelo herda da input image.
    const visuals = sceneForTake?.visuals ?? "";
    const framing = inferFraming(visuals);

    specs.push({
      takeIndex: i,
      takeKey,
      startTime,
      endTime,
      duration: Math.max(0.5, endTime - startTime),
      exactAction: sceneForTake?.action ?? "",
      exactVisuals: visuals,
      exactFraming: framing,
      exactBackground: extractBackground(visuals),
      exactWardrobe: extractWardrobe(visuals),
      peopleCount: sceneForTake?.peopleCount ?? 1,
      exactSpeechText: script,
      exactSpeaker: speaker,
      exactEmotion: voiceStyle?.emotion ?? null,
      transitionIn,
      transitionOut,
    });
  }

  return specs;
}

// "0-3s" → { start: 0, end: 3 }. "3s-6.5s" → { start: 3, end: 6.5 }.
function parseTimeRange(range: string): { start: number; end: number } {
  const match = range.replace(/\s/g, "").match(/^([\d.]+)s?-([\d.]+)s?$/);
  if (!match) return { start: 0, end: 8 };
  return { start: parseFloat(match[1]), end: parseFloat(match[2]) };
}

// Tenta inferir framing do texto "visuals". Se o Gemini escreveu "close no
// rosto", retorna "close-up"; se escreveu "wide mostrando o ambiente", retorna
// "wide shot". Caso contrário, null (deixa a input image resolver).
function inferFraming(visuals: string): string | null {
  const v = visuals.toLowerCase();
  if (/\bclose[-\s]?up\b|\bclose no rosto\b|\bclose shot\b/.test(v)) return "close-up";
  if (/\bwide\b|\bplano geral\b|\bfull body\b|\bcorpo inteiro\b/.test(v)) return "wide shot";
  if (/\bmedium\b|\bplano médio\b|\bmeio corpo\b/.test(v)) return "medium shot";
  if (/\bselfie\b|\bponto de vista\b|\bpov\b/.test(v)) return "selfie POV";
  return null;
}

// Extrai descrição do background do campo "visuals" (heurística simples).
function extractBackground(visuals: string): string | null {
  const v = visuals.toLowerCase();
  const match = v.match(/fundo\s+([^,.]+)|background\s+([^,.]+)|atrás\s+([^,.]+)/);
  if (match) return (match[1] ?? match[2] ?? match[3]).trim();
  return null;
}

// Extrai descrição da roupa (heurística — "vestido rosa", "blusa branca").
function extractWardrobe(visuals: string): string | null {
  const patterns = [
    /veste\s+([^,.]+)/i,
    /wearing\s+([^,.]+)/i,
    /(vestido|blusa|camiseta|camisa|moletom|saia|calça|short|macacão|jaqueta|casaco)\s+[^,.]*/i,
  ];
  for (const p of patterns) {
    const m = visuals.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

// ── Fidelity Validation via Gemini ───────────────────────────────────────

export interface FidelityScores {
  avatarConsistency: number;        // 0-1: mesmo avatar do início ao fim?
  backgroundMatch: number;          // 0-1: fundo bate com o original?
  cameraMatch: number;              // 0-1: enquadramento/ângulo batem?
  actionMatch: number;              // 0-1: ação bate?
  wardrobeTimingMatch: number;      // 0-1: troca de roupa no momento certo?
  speechExactness: number;          // 0-1: fala literal (1.0 = idêntica)
  speakerStructureMatch: number;    // 0-1: número/ordem de falantes batem?
  overallFidelity: number;          // 0-1: fidelidade geral
  verdict: "approved" | "rejected";
  issues: string[];                 // lista de problemas detectados
}

export const FIDELITY_THRESHOLDS = {
  avatarConsistency: 0.85,
  backgroundMatch: 0.85,
  cameraMatch: 0.80,
  actionMatch: 0.80,
  wardrobeTimingMatch: 0.90,
  speechExactness: 0.95,
  speakerStructureMatch: 1.0,
  overallFidelity: 0.80,
} as const;

// Valida um take gerado contra sua TAKE_SPEC usando Gemini (vídeo contra vídeo).
// Retorna scores + verdict. Usado pelo pipeline para decidir se regenera o take.
export async function validateTakeFidelity(params: {
  generatedVideoUrl: string;
  referencePlayUrl: string;
  takeSpec: TakeSpec;
}): Promise<FidelityScores | null> {
  const { generatedVideoUrl, referencePlayUrl, takeSpec } = params;
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return null;

  try {
    // Baixa os dois vídeos em paralelo
    const [genRes, refRes] = await Promise.all([
      fetch(generatedVideoUrl, { signal: AbortSignal.timeout(30000) }),
      fetch(referencePlayUrl, { signal: AbortSignal.timeout(30000) }),
    ]);
    if (!genRes.ok || !refRes.ok) return null;
    const [genBytes, refBytes] = await Promise.all([
      genRes.arrayBuffer(),
      refRes.arrayBuffer(),
    ]);
    // Gemini inline aceita ~18MB por parte
    if (genBytes.byteLength > 18 * 1024 * 1024 || refBytes.byteLength > 18 * 1024 * 1024) {
      console.warn("[fidelity] video too large for inline gemini validation");
      return null;
    }

    const instruction = `Você é um auditor de fidelidade de vídeo. Recebeu DOIS vídeos:
VIDEO 1 = vídeo de REFERÊNCIA (trecho ${takeSpec.startTime.toFixed(1)}s-${takeSpec.endTime.toFixed(1)}s do original)
VIDEO 2 = vídeo GERADO (reencenação do trecho, trocando apenas a pessoa pelo avatar escolhido)

Sua tarefa: pontuar a FIDELIDADE do VIDEO 2 em relação ao VIDEO 1. A única mudança permitida é a identidade da pessoa. TODO o resto deve ser idêntico: cenário, câmera, enquadramento, iluminação, movimento, pose, roupa, timing, ação, número de pessoas, fala.

Referência esperada do take:
- Ação: ${takeSpec.exactAction || "(não especificada)"}
- Visual: ${takeSpec.exactVisuals || "(não especificado)"}
- Enquadramento: ${takeSpec.exactFraming ?? "não especificado — preservar o do VIDEO 1"}
- Background: ${takeSpec.exactBackground ?? "preservar o do VIDEO 1"}
- Roupa: ${takeSpec.exactWardrobe ?? "preservar a do VIDEO 1"}
- Pessoas visíveis: ${takeSpec.peopleCount}
- Fala esperada (literal): "${takeSpec.exactSpeechText || "NENHUMA — vídeo silencioso"}"
- Modo do falante: ${takeSpec.exactSpeaker}

Retorne APENAS um JSON assim:
{
  "avatarConsistency": 0.0-1.0,
  "backgroundMatch": 0.0-1.0,
  "cameraMatch": 0.0-1.0,
  "actionMatch": 0.0-1.0,
  "wardrobeTimingMatch": 0.0-1.0,
  "speechExactness": 0.0-1.0,
  "speakerStructureMatch": 0.0-1.0,
  "overallFidelity": 0.0-1.0,
  "issues": ["lista curta de problemas detectados"]
}

Regras:
- avatarConsistency: 1.0 = mesmo avatar do início ao fim; penalize drift de rosto/corpo/cabelo/pele.
- backgroundMatch: 1.0 = fundo idêntico ao VIDEO 1.
- cameraMatch: 1.0 = mesmo enquadramento/ângulo/distância do VIDEO 1.
- actionMatch: 1.0 = mesma ação/movimento/gesto do VIDEO 1.
- wardrobeTimingMatch: 1.0 = roupa correta no timing certo; penalize mudança de roupa fora do momento.
- speechExactness: 1.0 SOMENTE se a fala do VIDEO 2 == fala esperada literalmente (sem adicionar/remover/parafrasear). Se silent, 1.0 quando ninguém fala nem mexe a boca.
- speakerStructureMatch: 1.0 = número e ordem de falantes iguais.
- overallFidelity: avalia o vídeo como um todo. ≥ 0.8 = aceitável.
- issues: liste problemas específicos (ex: "roupa mudou cedo demais", "avatar trocou de rosto no segundo 3", "fala foi parafraseada").
- Retorne SOMENTE o JSON, sem texto extra.`;

    const model = "gemini-2.5-flash";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: "VIDEO 1 — REFERENCE:" },
              { inlineData: { mimeType: "video/mp4", data: Buffer.from(refBytes).toString("base64") } },
              { text: "VIDEO 2 — GENERATED:" },
              { inlineData: { mimeType: "video/mp4", data: Buffer.from(genBytes).toString("base64") } },
              { text: instruction },
            ],
          }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!res.ok) {
      console.error("[fidelity] gemini validation error:", res.status);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;

    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<FidelityScores>;

    const scores: FidelityScores = {
      avatarConsistency: clamp01(parsed.avatarConsistency),
      backgroundMatch: clamp01(parsed.backgroundMatch),
      cameraMatch: clamp01(parsed.cameraMatch),
      actionMatch: clamp01(parsed.actionMatch),
      wardrobeTimingMatch: clamp01(parsed.wardrobeTimingMatch),
      speechExactness: clamp01(parsed.speechExactness),
      speakerStructureMatch: clamp01(parsed.speakerStructureMatch),
      overallFidelity: clamp01(parsed.overallFidelity),
      verdict: "approved",
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 10) : [],
    };

    // Verdict: reprova se qualquer score crítico cair abaixo do threshold
    const criticalFail =
      scores.avatarConsistency < FIDELITY_THRESHOLDS.avatarConsistency ||
      scores.backgroundMatch < FIDELITY_THRESHOLDS.backgroundMatch ||
      scores.speechExactness < FIDELITY_THRESHOLDS.speechExactness ||
      scores.overallFidelity < FIDELITY_THRESHOLDS.overallFidelity;
    scores.verdict = criticalFail ? "rejected" : "approved";

    return scores;
  } catch (err) {
    console.error("[fidelity] validation request failed:", err);
    return null;
  }
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ── Fashion Silent Exact Match Mode ──────────────────────────────────────
// Detecta vídeos silenciosos de fashion/outfit change onde a fidelidade de
// cenário é CRÍTICA (o original geralmente tem câmera fixa, fundo constante,
// e só a roupa varia). Nesse modo, forçamos:
// - takeCount = Gemini sceneCount exato (1 take por troca)
// - hard_cuts (nunca continuous)
// - Preservação total do cenário/câmera/enquadramento
// - Duração por take proporcional à duração real de cada cena no original

export function isFashionSilentMode(params: {
  hasNarration: boolean;
  scenes: SceneBreakdown[] | null;
  hasMultipleVariants?: boolean;
}): boolean {
  const { hasNarration, scenes, hasMultipleVariants } = params;
  if (hasNarration) return false;
  if (!scenes || scenes.length < 2) return false;
  // 1 pessoa em cada cena e múltiplas variantes → fashion/outfit change.
  const allSingle = scenes.every((s) => (s.peopleCount ?? 1) === 1);
  return allSingle && (hasMultipleVariants === true || scenes.length >= 2);
}
