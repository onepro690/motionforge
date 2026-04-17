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

  const { text } = await generateText({
    model: openai("gpt-4o"),
    prompt,
    temperature: 0.7,
  });

  const raw = parseJson<Record<string, string>>(text, {});

  const silentClause = isSilent
    ? " ABSOLUTELY SILENT — NO dialogue, NO speech, NO lip-sync, NO voiceover, NO narration, NO singing, NO whispering, NO mouthing words. The person's mouth MUST stay CLOSED at all times. Ambient sound or music only. This is a SILENT video — the person NEVER speaks."
    : narrationMode !== "creator_speaking"
      ? " No lip-sync on camera; ambient sound only — narration will be added in post as voice-over. Person does not speak directly to camera."
      : "";

  const sceneDesc = referenceScene
    ? `Setting: ${referenceScene.setting}. Outfit: ${referenceScene.outfit}. Objects visible: ${referenceScene.objects.join(", ")}. Lighting: ${referenceScene.lighting}. Framing: ${referenceScene.framing}. Camera angle: ${referenceScene.cameraAngle}. Mood: ${referenceScene.mood}. Color palette: ${referenceScene.colorPalette}.`
    : `Setting: ${brief.visualStyle}`;

  const baseScene = `Vertical 9:16 smartphone UGC video, handheld selfie feel. Animate this EXACT reference image — DO NOT change ANYTHING about the scene, person, outfit, background, objects, lighting, or framing. The ONLY change allowed is adding the specified speech/lip movement. The person is: ${personaDesc}. Scene: ${sceneDesc} The input image is the ABSOLUTE ground truth — reproduce it exactly, only adding natural movement and speech.${silentClause}`;

  // Strip speech instructions from GPT-4o output when video should be silent
  const stripSpeech = (s: string): string => {
    if (!isSilent) return s;
    return s
      .replace(/\b(says?|speaks?|narrat\w*|talk\w*|whisper\w*|mouth\w*|voice\w*|dialogue|lip.?sync|singing|say\w*)\b[^.!]*/gi, "")
      .replace(/[""][^""]*[""](?:\s*(?:she|he|they)\s+(?:says?|speaks?|narrat\w*))?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  const enforce = (s: string): string => {
    let out = stripSpeech(s);
    if (silentClause) {
      out += silentClause;
    }
    return out;
  };

  const consistencyClause = ` CRITICAL: This is a CONTINUOUS video — the person MUST be the EXACT SAME person across ALL takes. Same face, same skin tone, same hair (color, style, length), same body type, same ethnicity, same age. Do NOT change the person between takes. The input image shows the person — match them exactly.`;

  const noTextClause = ` ABSOLUTELY NO TEXT, NO CAPTIONS, NO SUBTITLES, NO WATERMARKS, NO LOGOS, NO SYMBOLS, NO WRITTEN WORDS, NO LETTERS, NO NUMBERS, NO EMOJIS anywhere in the video frame at any point. The video must be completely clean — pure visual content only, zero on-screen text or graphics of any kind.`;

  const anatomyClause = ` ANATOMY AND COMPOSITION: The person's body must be anatomically correct — full body proportions, no cut-off limbs, no body parts clipping through furniture or objects, no warped torso, no fused hands, no extra fingers, no morphing faces mid-shot. The person stays physically separate from surrounding objects (tables, chairs, walls) — no intersection or clipping. Framing must be stable: do NOT zoom in and crop out the person's body awkwardly, do NOT cut the head off at the top of the frame, do NOT have parts of the body disappear or glitch during motion.`;

  const result: VeoPrompts = {};
  for (let i = 0; i < takeCount; i++) {
    const key = `take${i + 1}`;
    const rawPrompt = raw[key] ?? raw[`take${i + 1}`];
    const defaultAction = i === 0 ? "intro shot" : i === takeCount - 1 ? `closing beat with ${productName} visible` : "demonstration";
    const fallback = `${baseScene} Take ${i + 1} — ${referenceScene?.action ?? defaultAction}, person interacts with the product naturally.`;
    let prompt = enforce(rawPrompt ?? fallback) + consistencyClause + noTextClause + anatomyClause;

    // Injeta a descrição EXATA da cena correspondente no vídeo de referência.
    // Resolve caso onde take N é VISUALMENTE diferente (ex: take 1 tem muita
    // gente gritando, take 2 tem só uma pessoa falando). Sem isso, o GPT-4o
    // só vê a cena da thumbnail e gera o mesmo visual pra todos os takes.
    if (scenes && scenes[i]) {
      const sc = scenes[i];
      prompt += ` REFERENCE SCENE FOR THIS TAKE (${sc.timeRange}) — the reference video at this exact moment shows: ${sc.visuals}. The action happening is: ${sc.action}. CRITICAL: Reproduce THIS specific scene's visuals, composition, number of people, their poses, expressions, camera framing, and energy EXACTLY as described. Do NOT use the visual from a different take — each take has its own distinct scene. If the reference shows multiple people, show multiple people. If the reference shows one person, show one person. Match the crowd size, position, and energy of THIS specific moment in the reference.`;
    }

    // Quando é creator_speaking, injeta o texto EXATO do transcript de referência
    // diretamente no prompt — não confia no GPT-4o para reproduzir palavra por palavra.
    const takeScript = copyByTake[key]?.trim();
    if (narrationMode === "creator_speaking" && takeScript) {
      prompt += ` The person speaks DIRECTLY to camera with natural lip-sync, pronouncing each word clearly and naturally in Brazilian Portuguese. They say EXACTLY these words (do NOT change, paraphrase, or omit any word): "${takeScript}". IMPORTANT: The input reference image defines EVERYTHING about the scene — the ONLY thing that changes is the person's mouth moving to speak these words. Do NOT alter the person's appearance, outfit, background, lighting, or any other visual element.`;

      // Instruções de pronúncia para palavras PT-BR que Veo 3 costuma errar.
      // "carrinho" (RR forte) vs "carinho" (R fraco) — são palavras DIFERENTES.
      const pronunciationNotes: string[] = [];
      if (/\bcarrinho\b/i.test(takeScript)) {
        pronunciationNotes.push(
          `The word "carrinho" has a DOUBLE R (RR) which in Brazilian Portuguese is pronounced as a strong aspirated H sound (like English "hat" or Spanish "jota"). Say it as "kah-HEE-nyoo" with a strong guttural H at the start of the second syllable. DO NOT pronounce it as "kah-REE-nyoo" (single soft R) — that would be "carinho" (affection), a completely different word. The RR must sound harsh and aspirated, NOT soft.`
        );
      }
      if (pronunciationNotes.length > 0) {
        prompt += ` PRONUNCIATION GUIDE: ${pronunciationNotes.join(" ")}`;
      }

      // Match tom/entonação do vídeo de referência — todos os takes usam a MESMA
      // voz para que o vídeo final soe coerente do início ao fim.
      if (voiceStyle) {
        prompt += ` VOICE STYLE — match the reference video's speaker EXACTLY. The speaker is ${voiceStyle.gender}, ${voiceStyle.ageRange}, with ${voiceStyle.pitch} pitch, ${voiceStyle.pace} pace, ${voiceStyle.energy} energy level, conveying ${voiceStyle.emotion}. Accent: ${voiceStyle.accentRegion}. Detailed voice characterization: ${voiceStyle.description}. CRITICAL: Use this EXACT voice, tone, pace, pitch, energy, and intonation for the ENTIRE take. All takes in this video MUST use the SAME voice — do not vary tone or style between takes, the whole video must sound like ONE continuous recording of the SAME person speaking in the SAME mood.`;
      }
    }

    // ── Instruções de continuidade entre takes ──
    // Os takes serão concatenados num vídeo contínuo. O movimento, posição e
    // expressão da pessoa devem encaixar suavemente de um take pro outro.
    if (takeCount > 1) {
      if (i === 0) {
        // Primeiro take: termina em posição natural de quem ainda está falando
        prompt += ` CONTINUITY: This is take ${i + 1} of ${takeCount} in a continuous video. End this take with the person still in a natural mid-conversation pose — do NOT end with a conclusive gesture, nod, or pause. The person should look like they are about to continue speaking. Keep the person looking at the camera in the same position throughout.`;
      } else if (i === takeCount - 1) {
        // Último take: começa da mesma posição natural
        prompt += ` CONTINUITY: This is the FINAL take (${i + 1} of ${takeCount}) in a continuous video. Start this take with the person in the EXACT same position, pose, and expression as the end of the previous take — looking directly at camera, mid-conversation. The person can naturally conclude at the end of this take.`;
      } else {
        // Takes do meio: começa e termina na mesma posição
        prompt += ` CONTINUITY: This is take ${i + 1} of ${takeCount} in a continuous video. Start with the person in the EXACT same position, pose, and expression as the end of the previous take. End with the person still in a natural mid-conversation pose — do NOT pause or change position. The person stays looking at the camera in the same spot throughout, as if this is one continuous recording.`;
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
