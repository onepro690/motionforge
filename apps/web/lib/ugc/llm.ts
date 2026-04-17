// All LLM-based generators for the UGC pipeline
// Reuses the same @ai-sdk/openai + generateText pattern as the rest of the app

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

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
  videoStructure: Record<string, string>;
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
  takeScripts: Record<string, string>;
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

export type VeoPrompts = Record<string, string>;

export interface VoiceStyleInput {
  pitch: string;
  pace: string;
  energy: string;
  emotion: string;
  accentRegion: string;
  gender: string;
  ageRange: string;
  description: string;
}

export interface SceneBreakdownInput {
  timeRange: string;
  action: string;
  visuals: string;
  speakerMode?: "none" | "solo" | "group_unison" | "multiple_alternating";
  peopleCount?: number;
}

export async function generateVeoPrompts(
  productName: string,
  brief: CreativeBrief,
  copyByTake: Record<string, string>,
  templateContent: string,
  characterName: string,
  referenceScene: ReferenceScene | null,
  takeCount: number = 3,
  voiceStyle: VoiceStyleInput | null = null,
  scenes: SceneBreakdownInput[] | null = null
): Promise<VeoPrompts> {
  const openai = getOpenAI();

  const personaDesc = `the person shown in the input image (character: ${characterName})`;
  const narrationMode = (brief as unknown as { narrationMode?: string }).narrationMode ?? "creator_speaking";
  const isSilent = narrationMode !== "creator_speaking" && !Object.values(copyByTake).some((s) => s && s.trim().length > 0);

  const sceneBlock = referenceScene
    ? JSON.stringify(referenceScene, null, 2)
    : "(sem análise visual — use o visualStyle do brief como fallback)";

  // Gera lista detalhada de "o que acontece em cada take no vídeo de referência".
  // Crítico quando os takes são visualmente DIFERENTES (ex: take 1 = multidão
  // gritando, take 2 = uma pessoa falando). Sem isso o GPT-4o gera prompts
  // genéricos que ignoram as diferenças entre cenas.
  const perTakeSceneBlock = scenes && scenes.length > 0
    ? scenes
        .slice(0, takeCount)
        .map((s, idx) => `Take ${idx + 1} (${s.timeRange}): ${s.action}. Visuals: ${s.visuals}`)
        .join("\n")
    : "(usando a mesma cena para todos os takes)";

  // Descobre se algum take vai precisar do "raw" do GPT-4o como fallback.
  // Em modo fala com script em TODOS os takes, o raw é descartado — então
  // evitamos a chamada desperdiçada ao GPT-4o (economia de custo e latência).
  let needsRaw = isSilent || narrationMode !== "creator_speaking";
  if (!needsRaw) {
    for (let i = 0; i < takeCount; i++) {
      const s = copyByTake[`take${i + 1}`]?.trim();
      if (!s) { needsRaw = true; break; }
    }
  }

  let raw: Record<string, string> = {};
  if (needsRaw) {
    const prompt = buildPrompt(templateContent, {
      product_name: productName,
      brief_data: JSON.stringify(brief, null, 2),
      copy_by_take: JSON.stringify(copyByTake, null, 2),
      visual_style: brief.visualStyle,
      persona_description: personaDesc,
      narration_mode: narrationMode,
      reference_scene: sceneBlock,
      per_take_scenes: perTakeSceneBlock,
    });

    try {
      const { text } = await generateText({
        model: openai("gpt-4o"),
        prompt,
        temperature: 0.7,
      });
      raw = parseJson<Record<string, string>>(text, {});
    } catch (err) {
      console.error("[llm.generateVeoPrompts] GPT-4o falhou, usando fallback:", err);
      raw = {};
    }
  }

  const silentClause = isSilent
    ? " ABSOLUTELY SILENT — NO dialogue, NO speech, NO lip-sync, NO voiceover, NO narration, NO singing, NO whispering, NO mouthing words. The person's mouth MUST stay CLOSED at all times. Ambient sound or music only. This is a SILENT video — the person NEVER speaks."
    : narrationMode !== "creator_speaking"
      ? " No lip-sync on camera; ambient sound only — narration will be added in post as voice-over. Person does not speak directly to camera."
      : "";

  const sceneDesc = referenceScene
    ? `Setting: ${referenceScene.setting}. Outfit: ${referenceScene.outfit}. Objects visible: ${referenceScene.objects.join(", ")}. Lighting: ${referenceScene.lighting}. Framing: ${referenceScene.framing}. Camera angle: ${referenceScene.cameraAngle}. Mood: ${referenceScene.mood}. Color palette: ${referenceScene.colorPalette}.`
    : `Setting: ${brief.visualStyle}`;

  // ──────────────────────────────────────────────────────────────────────
  // Prompts ultra-compactos pro Veo 3. Quando o prompt é longo demais, o
  // Veo ignora a instrução de fala e gera vídeo genérico com música/inglês.
  // Estratégia: SPEECH FIRST (pt-BR + script literal), depois restrições
  // curtas. O raw output do GPT-4o só é usado como fallback quando NÃO tem
  // script (silent mode).
  // ──────────────────────────────────────────────────────────────────────

  const baseScene = `Vertical 9:16 smartphone UGC video, handheld selfie feel. The person is: ${personaDesc}. Scene: ${sceneDesc}`;

  const stripSpeech = (s: string): string => {
    if (!isSilent) return s;
    return s
      .replace(/\b(says?|speaks?|narrat\w*|talk\w*|whisper\w*|mouth\w*|voice\w*|dialogue|lip.?sync|singing|say\w*)\b[^.!]*/gi, "")
      .replace(/[""][^""]*[""](?:\s*(?:she|he|they)\s+(?:says?|speaks?|narrat\w*))?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  // Clauses CURTAS e focadas. Veo 3 precisa de densidade, não volume.
  const imageFidelity = `IMAGE FIDELITY: the input image is the ground truth. Keep the background, outfit, framing, lighting, and exact number of people identical. Do NOT add crowds, extra people, new environments, or props that aren't in the image.`;
  const identityLock = `IDENTITY LOCK: the person's face, hair, skin tone, and outfit stay 100% identical from first to last frame — no morphing, no drift.`;
  const noTextShort = `No captions, subtitles, watermarks, or on-screen text.`;
  const anatomyShort = `Anatomy correct: no cut-off limbs, no clipping through furniture, no fused hands or extra fingers. Keep the full head and upper body inside the frame throughout the take — no zoom-in crops, no head chopping, no body parts disappearing off-screen, stable framing.`;

  const result: VeoPrompts = {};
  for (let i = 0; i < takeCount; i++) {
    const key = `take${i + 1}`;
    const takeScript = copyByTake[key]?.trim();
    const sceneForTake = scenes?.[i];

    let prompt: string;

    if (narrationMode === "creator_speaking" && takeScript) {
      // ── MODO FALA: speech-first prompt, curto e denso ──
      const speakerMode = sceneForTake?.speakerMode ?? "solo";
      const visualsText = (sceneForTake?.visuals ?? "").toLowerCase() + " " + (sceneForTake?.action ?? "").toLowerCase();
      const looksLikeGroup = /\b(grupo|várias pessoas|varias pessoas|muita gente|multidão|multidao|coro|crowd|group|together|juntas|juntos|todos|todas|em uníssono|em unissono)\b/.test(visualsText);
      const effectiveMode = speakerMode !== "solo" ? speakerMode : (looksLikeGroup ? "group_unison" : "solo");
      const wordCount = takeScript.split(/\s+/).filter(Boolean).length;

      // Speech block FIRST — Veo 3 prioriza o começo do prompt.
      let speechBlock: string;
      if (effectiveMode === "group_unison") {
        const pc = sceneForTake?.peopleCount && sceneForTake.peopleCount > 1 ? sceneForTake.peopleCount : 0;
        speechBlock = `Vertical 9:16 UGC smartphone selfie video. ${pc > 0 ? `${pc} people` : "Multiple people"} visible in the input image speak IN UNISON (all together, synchronized) directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR). They say EXACTLY these ${wordCount} words — every single word, nothing added, nothing removed, no English, no mumbling: "${takeScript}". After the last word they close their mouths and stop. AUDIO TRACK: ONLY the group's voices speaking in Portuguese — ZERO background music, ZERO sound effects, ZERO other languages, ZERO singing.`;
      } else if (effectiveMode === "multiple_alternating") {
        speechBlock = `Vertical 9:16 UGC smartphone selfie video. Multiple people visible in the input image take turns speaking directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR). Together across all speakers they say EXACTLY these ${wordCount} words — every single word, nothing added, nothing removed, no English, no mumbling: "${takeScript}". After the last word they close their mouths and stop. AUDIO TRACK: ONLY the speakers' voices in Portuguese — ZERO background music, ZERO sound effects, ZERO other languages.`;
      } else {
        speechBlock = `Vertical 9:16 UGC smartphone selfie video. The person in the input image speaks DIRECTLY TO CAMERA with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR). They say EXACTLY these ${wordCount} words — every single word, nothing added, nothing removed, no English, no mumbling: "${takeScript}". Start speaking within the first 0.3 seconds. Finish the last word before the take ends. After the last word close the mouth and stop. AUDIO TRACK: ONLY the person's voice in Portuguese — ZERO background music, ZERO sound effects, ZERO other voices, ZERO other languages, ZERO singing.`;
      }

      prompt = `${speechBlock} ${imageFidelity} ${identityLock} ${noTextShort} ${anatomyShort}`;

      // Pronunciation (opcional, curto)
      if (/\bcarrinho\b/i.test(takeScript)) {
        prompt += ` Pronounce "carrinho" with strong aspirated RR (kah-HEE-nyoo), NOT soft R (kah-REE-nyoo = different word).`;
      }

      // Voice style (curto)
      if (voiceStyle) {
        prompt += ` Voice: ${voiceStyle.gender}, ${voiceStyle.ageRange}, ${voiceStyle.pitch} pitch, ${voiceStyle.pace} pace, ${voiceStyle.energy} energy, ${voiceStyle.emotion} emotion, ${voiceStyle.accentRegion} accent. Keep the SAME voice in every take.`;
      }

      // Continuity (curto)
      if (takeCount > 1) {
        if (i === 0) {
          prompt += ` End still mid-conversation — don't pause or conclude.`;
        } else if (i === takeCount - 1) {
          prompt += ` Start in the same pose as the previous take's last frame. This is the final take.`;
        } else {
          prompt += ` Start in the same pose as the previous take's last frame, end still mid-conversation.`;
        }
      }
    } else {
      // ── MODO SILENCIOSO / VOICEOVER: usa raw GPT-4o + clauses ──
      const rawPrompt = raw[key] ?? raw[`take${i + 1}`];
      const defaultAction = i === 0 ? "intro shot" : i === takeCount - 1 ? `closing beat with ${productName} visible` : "demonstration";
      const fallback = `${baseScene} Take ${i + 1} — ${referenceScene?.action ?? defaultAction}, person interacts with the product naturally.${silentClause}`;
      prompt = (stripSpeech(rawPrompt ?? fallback) + silentClause).trim();
      prompt += ` ${imageFidelity} ${identityLock} ${noTextShort} ${anatomyShort}`;

      if (sceneForTake) {
        prompt += ` Scene action: ${sceneForTake.action}.`;
      }
    }

    result[key] = prompt;
  }

  return result;
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
