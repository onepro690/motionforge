// All LLM-based generators for the UGC pipeline
// Reuses the same @ai-sdk/openai + generateText pattern as the rest of the app

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { personaToDescription, type UgcPersona } from "./personas";

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY não configurada");
  return createOpenAI({ apiKey });
}

function buildPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const raw = text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : raw) as T;
  } catch {
    return fallback;
  }
}

// ── Creative Analysis ──────────────────────────────────────────────────────

export interface CreativeAnalysis {
  productSummary: string;
  mainBenefits: string[];
  mainPains: string[];
  dominantHooks: string[];
  hookTypes: string[];
  dominantStyles: string[];
  copyPatterns: string[];
  successSignals: string[];
  ugcAngles: string[];
  trendSummary: string;
}

export async function analyzeCreative(
  productName: string,
  videoDescriptions: string[],
  templateContent: string
): Promise<CreativeAnalysis> {
  const openai = getOpenAI();
  const videosData = videoDescriptions
    .slice(0, 10)
    .map((d, i) => `Vídeo ${i + 1}: "${d}"`)
    .join("\n");

  const prompt = buildPrompt(templateContent, {
    product_name: productName,
    videos_data: videosData || "Sem vídeos detectados — use conhecimento geral sobre o produto.",
  });

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt,
    temperature: 0.7,
  });

  return parseJson<CreativeAnalysis>(text, {
    productSummary: `${productName} é um produto em alta no TikTok Shop`,
    mainBenefits: ["praticidade", "qualidade", "custo-benefício"],
    mainPains: ["problema comum", "necessidade do dia a dia"],
    dominantHooks: ["Você precisa ver isso", "Esse produto mudou minha rotina", "Não acredito que não tinha isso antes"],
    hookTypes: ["descoberta", "transformação"],
    dominantStyles: ["review", "demonstração"],
    copyPatterns: ["problema → solução → resultado"],
    successSignals: ["alto engajamento", "múltiplos creators usando"],
    ugcAngles: ["descoberta casual", "review honesto", "antes e depois"],
    trendSummary: `${productName} está ganhando tração com múltiplos criadores`,
  });
}

// ── Creative Brief ─────────────────────────────────────────────────────────

export interface CreativeBrief {
  angle: string;
  tone: string;
  targetAudience: string;
  mainProblem: string;
  desiredOutcome: string;
  videoStructure: { take1: string; take2: string; take3: string };
  suggestedHooks: string[];
  suggestedCtas: string[];
  visualStyle: string;
  // "creator_speaking" = pessoa falando direto pra câmera (lip-sync)
  // "voiceover_narrator" = narrador em off + b-roll/produto em foco
  // Brief DECIDE upfront e todos os takes respeitam essa escolha.
  narrationMode: "creator_speaking" | "voiceover_narrator";
}

export async function generateBrief(
  productName: string,
  analysis: CreativeAnalysis,
  recentAngles: string[],
  templateContent: string
): Promise<CreativeBrief> {
  const openai = getOpenAI();

  const prompt = buildPrompt(templateContent, {
    product_name: productName,
    analysis_data: JSON.stringify(analysis, null, 2),
    recent_angles: recentAngles.length ? recentAngles.join(", ") : "nenhum ainda",
  });

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt,
    temperature: 0.85,
  });

  return parseJson<CreativeBrief>(text, {
    angle: "descoberta genuína de produto útil",
    tone: "surpresa e empolgação",
    targetAudience: "mulheres 18-35 interessadas em produtos práticos",
    mainProblem: "problema cotidiano que o produto resolve",
    desiredOutcome: "vida mais fácil e prática",
    videoStructure: {
      take1: "hook de surpresa mostrando o produto",
      take2: "demonstração rápida do benefício principal",
      take3: "resultado final + CTA para comprar",
    },
    suggestedHooks: ["Você conhece esse produto?", "Isso mudou minha rotina completamente"],
    suggestedCtas: ["Link na bio para comprar!", "Já está no meu carrinho"],
    visualStyle: "selfie casual em ambiente doméstico, iluminação natural",
    narrationMode: "creator_speaking",
  });
}

// ── Copy Writer ────────────────────────────────────────────────────────────

export interface VideoScript {
  fullScript: string;
  takeScripts: { take1: string; take2: string; take3: string };
  hookUsed: string;
  ctaUsed: string;
  angleUsed: string;
  styleUsed: string;
}

export async function writeCopy(
  productName: string,
  brief: CreativeBrief,
  recentHooks: string[],
  recentCtas: string[],
  templateContent: string,
  remakeInstructions?: string
): Promise<VideoScript> {
  const openai = getOpenAI();

  const briefWithInstructions = remakeInstructions
    ? { ...brief, remakeInstructions }
    : brief;

  const prompt = buildPrompt(templateContent, {
    product_name: productName,
    brief_data: JSON.stringify(briefWithInstructions, null, 2),
    recent_hooks: recentHooks.length ? recentHooks.slice(-5).join(", ") : "nenhum ainda",
    recent_ctas: recentCtas.length ? recentCtas.slice(-5).join(", ") : "nenhum ainda",
  });

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt,
    temperature: 0.9,
  });

  return parseJson<VideoScript>(text, {
    fullScript: `Vocês precisam ver esse produto! ${productName} mudou minha rotina completamente. Não consigo imaginar minha vida sem ele agora. Link na bio!`,
    takeScripts: {
      take1: `Vocês precisam ver esse ${productName}! Não acredito que não sabia disso antes.`,
      take2: `Olha como funciona — é simples assim! Em segundos você já vê a diferença.`,
      take3: `Sinceramente? Melhor compra do mês. Link na bio, é do TikTok Shop!`,
    },
    hookUsed: `Vocês precisam ver esse ${productName}!`,
    ctaUsed: "Link na bio, é do TikTok Shop!",
    angleUsed: "descoberta genuína",
    styleUsed: "review",
  });
}

// ── Reference Scene Analyzer (vision) ─────────────────────────────────────

export interface ReferenceScene {
  setting: string;          // Descrição do ambiente/local (sem pessoa).
  outfit: string;           // Roupa visível (cor, tipo, estilo).
  objects: string[];        // Objetos visíveis ao redor, incluindo o produto.
  lighting: string;         // Tipo e direção da luz.
  framing: string;          // Enquadramento/câmera (selfie, close, wide etc).
  cameraAngle: string;      // Ângulo (eye-level, high, low).
  action: string;           // O que a pessoa está fazendo com o produto.
  mood: string;             // Tom visual geral.
  colorPalette: string;     // Paleta dominante.
}

// Usa GPT-4o-mini com visão pra extrair a "receita visual" do frame de
// referência — cenário, roupa, objetos, luz — SEM descrever a identidade da
// pessoa (etnia, face, idade). Isso permite que o Veo replique o cenário
// exato e a gente troque só o avatar.
export async function analyzeReferenceScene(
  thumbnailUrl: string,
  productName: string,
  videoDescription?: string
): Promise<ReferenceScene | null> {
  if (!thumbnailUrl) return null;
  const openai = getOpenAI();

  const systemPrompt = `Você é um especialista em direção de arte de vídeo UGC.
Vou te mostrar o frame de um vídeo TikTok que vende o produto "${productName}".
${videoDescription ? `Descrição textual do vídeo: "${videoDescription}"\n` : ""}
Extraia a RECEITA VISUAL COMPLETA do cenário para que possamos REPLICAR exatamente esse mesmo ambiente, roupa, objetos e enquadramento em outro vídeo — SEM copiar a identidade da pessoa (não descreva rosto, etnia, idade, gênero).

Retorne APENAS um JSON com esta estrutura:
{
  "setting": "descrição do ambiente/local (quarto, cozinha, banheiro, sala, fundo neutro, rua, etc) com detalhes do background",
  "outfit": "roupa visível: tipo, cor, estilo (ex: 'blusa branca básica de alça fina', 'moletom cinza oversized')",
  "objects": ["objeto 1 visível", "objeto 2 visível", "o produto em si"],
  "lighting": "tipo/direção da luz (ex: 'luz natural vindo de janela lateral à esquerda', 'ring light frontal')",
  "framing": "enquadramento (ex: 'selfie vertical close no rosto e tronco', 'wide shot mostrando o produto na bancada')",
  "cameraAngle": "ângulo da câmera (eye-level, high-angle, low-angle, POV)",
  "action": "o que a pessoa faz com o produto neste momento",
  "mood": "tom visual (casual, clean, cozy, aspirational, chaotic, minimal)",
  "colorPalette": "paleta dominante (ex: 'tons neutros bege e branco', 'rosa e pastel')"
}

Regras:
- NÃO descreva identidade da pessoa (rosto, etnia, idade, gênero, cabelo).
- SEJA específico: cores, materiais, distância da câmera, elementos do fundo.
- Se alguma info não estiver visível, use null para o campo.
- Retorne APENAS o JSON.`;

  try {
    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: systemPrompt },
            { type: "image", image: new URL(thumbnailUrl) },
          ],
        },
      ],
    });
    return parseJson<ReferenceScene>(text, null as unknown as ReferenceScene);
  } catch (err) {
    console.error("[llm.analyzeReferenceScene] falhou:", err);
    return null;
  }
}

// ── Veo Prompt Generator ───────────────────────────────────────────────────

export interface VeoPrompts {
  take1: string;
  take2: string;
  take3: string;
}

export async function generateVeoPrompts(
  productName: string,
  brief: CreativeBrief,
  copyByTake: { take1: string; take2: string; take3: string },
  templateContent: string,
  persona: UgcPersona,
  referenceScene: ReferenceScene | null
): Promise<VeoPrompts> {
  const openai = getOpenAI();

  const personaDesc = personaToDescription(persona);
  const narrationMode = (brief as unknown as { narrationMode?: string }).narrationMode ?? "creator_speaking";
  const sceneBlock = referenceScene
    ? JSON.stringify(referenceScene, null, 2)
    : "(sem análise visual — use o visualStyle do brief como fallback)";

  const prompt = buildPrompt(templateContent, {
    product_name: productName,
    brief_data: JSON.stringify(brief, null, 2),
    copy_by_take: JSON.stringify(copyByTake, null, 2),
    visual_style: brief.visualStyle,
    persona_description: personaDesc,
    narration_mode: narrationMode,
    reference_scene: sceneBlock,
  });

  const { text } = await generateText({
    model: openai("gpt-4o"),
    prompt,
    temperature: 0.7,
  });

  const raw = parseJson<{ take1?: string; take2?: string; take3?: string }>(text, {});

  const speaks = narrationMode === "creator_speaking";
  const hasScript = Object.values(copyByTake).some((s) => s && s.trim().length > 0);
  const silentClause = !speaks && !hasScript
    ? " SILENT TAKE — no dialogue, no speech, no lip-sync, person's mouth stays closed, no voiceover, ambient sound only. Person must NOT speak or mouth any words."
    : !speaks
      ? " No lip-sync on camera; ambient sound only — narration will be added in post as voice-over. Person does not speak directly to camera."
      : "";

  const sceneDesc = referenceScene
    ? `Setting: ${referenceScene.setting}. Outfit: ${referenceScene.outfit}. Objects visible: ${referenceScene.objects.join(", ")}. Lighting: ${referenceScene.lighting}. Framing: ${referenceScene.framing}. Camera angle: ${referenceScene.cameraAngle}. Mood: ${referenceScene.mood}. Color palette: ${referenceScene.colorPalette}.`
    : `Setting: ${brief.visualStyle}`;

  // Cada take agora recebe sua própria imagem de referência (frame extraído
  // do vídeo original naquele momento + Nano Banana). O prompt de texto é
  // complementar: descreve a cena e a persona, mas a fidelidade visual
  // vem do image-to-video. A cláusula de silêncio é a parte mais crítica
  // porque o Veo tende a gerar fala se não for explicitamente proibido.
  const baseScene = `Vertical 9:16 smartphone UGC video, handheld selfie feel. Animate this reference image. The person is: ${personaDesc}. Scene: ${sceneDesc} Keep the same outfit, objects, lighting, and framing shown in the input image.${silentClause}`;

  const enforce = (s: string): string => {
    let out = s;
    if (silentClause && !/\b(no dialogue|silent|no speech|no voiceover|mouth stays closed)\b/i.test(out)) {
      out += silentClause;
    }
    return out;
  };

  return {
    take1: enforce(raw.take1 ?? `${baseScene} Take 1 — ${referenceScene?.action ?? "intro shot"}, person interacts with the product naturally.`),
    take2: enforce(raw.take2 ?? `${baseScene} Take 2 — continue from previous take, ${referenceScene?.action ?? "demonstration"}, same person same location.`),
    take3: enforce(raw.take3 ?? `${baseScene} Take 3 — same person, same room, closing beat with ${productName} visible.`),
  };
}

// ── Remake Instructions ────────────────────────────────────────────────────

export interface RemakeInstructions {
  feedbackInterpretation: string;
  changeType: string;
  newAngle: string;
  newTone: string;
  newHook: string;
  newStructure: string;
  instructionsForCopy: string;
  instructionsForVeo: string;
  keepWhat: string;
}

export async function parseRemakeFeedback(
  feedback: string,
  productName: string,
  previousAngle: string,
  previousHook: string,
  previousStyle: string,
  previousScript: string,
  templateContent: string
): Promise<RemakeInstructions> {
  const openai = getOpenAI();

  const prompt = buildPrompt(templateContent, {
    feedback,
    product_name: productName,
    previous_angle: previousAngle,
    previous_hook: previousHook,
    previous_style: previousStyle,
    previous_script: previousScript,
  });

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt,
    temperature: 0.8,
  });

  return parseJson<RemakeInstructions>(text, {
    feedbackInterpretation: feedback,
    changeType: "style",
    newAngle: "nova perspectiva diferente",
    newTone: "mais natural e casual",
    newHook: "hook completamente diferente do anterior",
    newStructure: "mesma estrutura de 3 takes",
    instructionsForCopy: `Reescreva o roteiro sendo mais ${feedback}`,
    instructionsForVeo: "Torne os prompts mais naturais e UGC",
    keepWhat: "o produto em destaque em todos os takes",
  });
}

// ── Caption Generator ──────────────────────────────────────────────────────

export async function generateCaption(
  productName: string,
  script: string,
  templateContent: string
): Promise<string> {
  const openai = getOpenAI();

  const prompt = buildPrompt(templateContent, {
    product_name: productName,
    script,
  });

  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt,
    temperature: 0.9,
  });

  return text.trim() || `${productName} do TikTok Shop 🔥 Link na bio! #tiktokshop #viral #review`;
}
