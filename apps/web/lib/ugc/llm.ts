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

import type { TakeSpec } from "./fidelity";

export async function generateVeoPrompts(
  productName: string,
  brief: CreativeBrief,
  copyByTake: Record<string, string>,
  templateContent: string,
  characterName: string,
  referenceScene: ReferenceScene | null,
  takeCount: number = 3,
  voiceStyle: VoiceStyleInput | null = null,
  scenes: SceneBreakdownInput[] | null = null,
  takeSpecs: TakeSpec[] | null = null
): Promise<VeoPrompts> {
  const narrationMode = (brief as unknown as { narrationMode?: string }).narrationMode ?? "creator_speaking";
  const isSilent = narrationMode !== "creator_speaking" && !Object.values(copyByTake).some((s) => s && s.trim().length > 0);

  // ──────────────────────────────────────────────────────────────────────
  // Em STRICT_REFERENCE_FIDELITY a chamada GPT-4o para "raw prompt" foi
  // removida. Os prompts agora são montados 100% a partir das TAKE_SPECs
  // + das cenas Gemini + do script Whisper literal. Qualquer texto gerado
  // pelo GPT-4o introduziria linguagem criativa/generativa — exatamente o
  // que queremos bloquear neste modo.
  // ──────────────────────────────────────────────────────────────────────
  // Evita warnings de unused. `templateContent` fica no signature por
  // compatibilidade e uso futuro.
  void templateContent; void referenceScene;

  // ──────────────────────────────────────────────────────────────────────
  // STRICT REFERENCE FIDELITY — prompts de REENCENAÇÃO, não de criação.
  // Arquitetura: ação/cena PRIMEIRO (Veo pesa o começo), locks consolidados
  // no fim em um bloco curto. Versões antigas empilhavam ~6000 chars de
  // locks ANTES da ação do Gemini e Veo ignorava a ação.
  // ──────────────────────────────────────────────────────────────────────

  // Constrói um bloco de instruções de reprodução a partir da TAKE_SPEC ou das cenas.
  const buildReferenceBlock = (i: number): string => {
    const spec = takeSpecs?.[i];
    const sceneForTake = scenes?.[i];
    const parts: string[] = [];

    if (spec) {
      parts.push(`REFERENCE SEGMENT: this take reproduces seconds ${spec.startTime.toFixed(1)}s–${spec.endTime.toFixed(1)}s of the original video (duration ${spec.duration.toFixed(1)}s).`);
      if (spec.exactAction) parts.push(`Reproduce this EXACT action: "${spec.exactAction}".`);
      if (spec.exactVisuals) parts.push(`Match these EXACT visuals: "${spec.exactVisuals}".`);
      if (spec.exactFraming) parts.push(`Keep the framing as "${spec.exactFraming}".`);
      if (spec.exactBackground) parts.push(`Background: "${spec.exactBackground}".`);
      if (spec.exactWardrobe) parts.push(`Wardrobe for this take: "${spec.exactWardrobe}".`);
      if (spec.peopleCount > 1) {
        parts.push(`People count: EXACTLY ${spec.peopleCount} people visible — do NOT merge them, do NOT remove any, do NOT add more.`);
      }
    } else if (sceneForTake) {
      parts.push(`REFERENCE SEGMENT (${sceneForTake.timeRange ?? `take ${i + 1}`}): reproduce this EXACT action: "${sceneForTake.action}". Match these visuals: "${sceneForTake.visuals}".`);
      if (sceneForTake.peopleCount && sceneForTake.peopleCount > 1) {
        parts.push(`People count: EXACTLY ${sceneForTake.peopleCount} people visible — preserve all of them.`);
      }
    }

    return parts.join(" ");
  };

  // Hard people-count lock: Veo 3 tende a adicionar pessoas extras quando
  // a cena tem movimento + múltiplas bocas falando. Reforçamos com um block
  // dedicado que aparece em TODO prompt (speech e silent), sempre que o
  // Gemini/TAKE_SPEC nos deu um número. Sem número → instruímos a copiar
  // o input image.
  const buildPeopleLock = (i: number): string => {
    const spec = takeSpecs?.[i];
    const sceneForTake = scenes?.[i];
    const pc = spec?.peopleCount ?? sceneForTake?.peopleCount ?? null;
    if (pc && pc > 0) {
      return `PEOPLE COUNT LOCK: the scene shows EXACTLY ${pc} ${pc === 1 ? "person" : "people"} — no more, no less. Do NOT add a ${pc + 1}${pc + 1 === 2 ? "nd" : pc + 1 === 3 ? "rd" : "th"} person, do NOT duplicate anyone, do NOT spawn bystanders/reflections/background people, do NOT split one person into multiple. If the input image has ${pc} ${pc === 1 ? "person" : "people"}, keep exactly ${pc} throughout the entire take.`;
    }
    return `PEOPLE COUNT LOCK: match the exact number of people visible in the input image. Do NOT add extra people, do NOT duplicate anyone, do NOT spawn bystanders or reflections. If the input image shows 1 person keep 1; if it shows 2 people keep 2; etc.`;
  };

  // ─── Prompt architecture: ACTION FIRST, then LOCKS ──────────────────────
  // Veo 3 weighs the START of the prompt hardest. Older versions buried the
  // actual scene description (action/visuals from Gemini) after ~1500 chars
  // of meta-locks (languageLock, noTextLock, aspectLock…). Result: Veo would
  // apply the locks but ignore the specific action, producing generic videos
  // that didn't match the reference. New order:
  //   1. ONE-LINER reenactment directive
  //   2. SCENE (action + visuals from Gemini — the single most important line)
  //   3. SPEECH (literal text if speaking) OR silence clause
  //   4. Consolidated lock block at the end (short, specific)

  // Combined lock block — shorter than before, deduplicated, covering all
  // critical constraints without drowning the scene description.
  const combinedLockBlock = (speaking: boolean) => {
    const parts = [
      `SCENE LOCK: background, room, props, camera angle, camera distance, framing, lighting, color grading, and composition are FIXED by the input image. Do NOT reinterpret. Do NOT zoom or pan beyond the input framing.`,
      `IDENTITY LOCK: face, skin tone, hair, body must stay PIXEL-identical to the input image from frame 1 to the last frame — no morphing, no drift.`,
      `COLOR LOCK: preserve white balance, saturation, contrast, skin tone of the input image with ZERO drift. Do NOT add warm/yellow/sepia/amber tint, do NOT boost saturation, do NOT apply a "cinematic" look.`,
      `ASPECT: output 9:16 vertical edge-to-edge — NO letterbox, NO black bars, NO pillarbox.`,
      `ZERO ON-SCREEN TEXT: NO burnt captions, subtitles, auto-subtitles, TikTok/Instagram captions, title cards, watermarks, hashtags, emojis, or any written characters rendered as video overlay.`,
      `FORBIDDEN: adding or removing people, changing wardrobe mid-take, changing background mid-take, morphing face, adding tattoos/piercings not in the input, cut-off limbs, extra fingers, head chopping, body parts leaving the frame.`,
      speaking
        ? `LANGUAGE LOCK: spoken audio is 100% BRAZILIAN PORTUGUESE (pt-BR). FORBIDDEN: English, Mandarin, Cantonese, Japanese, Korean, Spanish, European Portuguese, or any other language. If a word can't be rendered in pt-BR, stay silent — do NOT switch language, do NOT mumble.`
        : `SILENCE LOCK: mouth stays CLOSED — no lip-sync, no speech, no singing, no mouthing of words. Audio: ambient only, ZERO voices.`,
    ];
    return parts.join(" ");
  };

  const result: VeoPrompts = {};
  for (let i = 0; i < takeCount; i++) {
    const key = `take${i + 1}`;
    const takeScript = copyByTake[key]?.trim();
    const sceneForTake = scenes?.[i];
    const spec = takeSpecs?.[i];
    const referenceBlock = buildReferenceBlock(i);
    const peopleLock = buildPeopleLock(i);

    let prompt: string;

    if (narrationMode === "creator_speaking" && takeScript) {
      // ── SPEECH REENACTMENT ────────────────────────────────────────────
      const speakerMode = spec?.exactSpeaker ?? sceneForTake?.speakerMode ?? "solo";
      const visualsText = (sceneForTake?.visuals ?? spec?.exactVisuals ?? "").toLowerCase() + " " + (sceneForTake?.action ?? spec?.exactAction ?? "").toLowerCase();
      const looksLikeGroup = /\b(grupo|várias pessoas|varias pessoas|muita gente|multidão|multidao|coro|crowd|group|together|juntas|juntos|todos|todas|em uníssono|em unissono)\b/.test(visualsText);
      const effectiveMode = speakerMode !== "solo" && speakerMode !== "none" ? speakerMode : (looksLikeGroup ? "group_unison" : "solo");
      const peopleCount = spec?.peopleCount ?? sceneForTake?.peopleCount ?? 1;

      // 1) Opening directive (short)
      const opener = `REENACT THIS REFERENCE SHOT — reproduce the input image's scene exactly. The only thing you may change is the person's identity (use the face/body/skin/hair from the input image). Everything else (scene, camera, framing, lighting, pose, motion, wardrobe, props) must match the input image.`;

      // 2) SCENE (the highest-signal line: what happens, how it looks)
      const sceneLine = referenceBlock
        ? `SCENE TO REENACT: ${referenceBlock}`
        : `SCENE TO REENACT: reproduce exactly what the input image shows — same pose, same framing, same action implied by the input.`;

      // 3) SPEECH block — literal text, who speaks, lip-sync directive
      let speechBlock: string;
      if (effectiveMode === "group_unison") {
        const pc = peopleCount > 1 ? peopleCount : 0;
        speechBlock = `SPEECH: ${pc > 0 ? `the ${pc} people` : "the group"} in the input image speak IN UNISON directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE. They say LITERALLY this text, word-for-word, no paraphrase: "${takeScript}". After the last word, mouths close and stop. AUDIO: only the group's voices — ZERO music, ZERO other sounds.`;
      } else if (effectiveMode === "multiple_alternating") {
        speechBlock = `SPEECH: the people in the input image take turns speaking directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE, preserving the reference's alternation/timing. Across speakers they say LITERALLY: "${takeScript}". After the last word, mouths close. AUDIO: only the voices — ZERO music, ZERO other sounds.`;
      } else {
        speechBlock = `SPEECH: the person in the input image speaks DIRECTLY TO CAMERA with natural lip-sync in BRAZILIAN PORTUGUESE. They say LITERALLY this text, word-for-word, no paraphrase, no translation: "${takeScript}". Start speaking within 0.3s. After the last word, close the mouth. AUDIO: only the person's voice — ZERO music, ZERO other sounds.`;
      }

      // 4) Voice style echo (short)
      let voiceLine = "";
      if (voiceStyle) {
        voiceLine = ` VOICE: match the reference — ${voiceStyle.gender}, ${voiceStyle.ageRange}, ${voiceStyle.pitch} pitch, ${voiceStyle.pace} pace, ${voiceStyle.energy} energy, ${voiceStyle.emotion}, ${voiceStyle.accentRegion}. Same voice across every take.`;
      }
      if (spec?.exactEmotion) voiceLine += ` Emotion: ${spec.exactEmotion}.`;

      // 5) Continuity between takes
      let continuityLine = "";
      if (takeCount > 1 && spec) {
        if (spec.transitionIn === "continuous") {
          continuityLine += ` Start in the same pose as the previous take's last frame.`;
        } else if (spec.transitionIn === "hard_cut" && i > 0) {
          continuityLine += ` Hard-cut from prior take — begin in the pose/framing of THIS take's input image.`;
        }
        if (spec.transitionOut === "continuous" && i < takeCount - 1) {
          continuityLine += ` End still mid-flow; next take continues.`;
        } else if (i === takeCount - 1) {
          continuityLine += ` Final take — end cleanly.`;
        }
      }

      // 6) Pronunciation hint (opcional)
      let pronLine = "";
      if (/\bcarrinho\b/i.test(takeScript)) {
        pronLine = ` Pronounce "carrinho" with aspirated RR (kah-HEE-nyoo).`;
      }

      // 7) Locks (consolidated, at the end)
      const locks = combinedLockBlock(true);

      // 8) Tail dialog lock — repetir texto no final ajuda Veo a não desviar
      const tailDialog = ` FINAL DIALOG LOCK: spoken line is EXACTLY this pt-BR text: "${takeScript}". No English, no Chinese, no paraphrase, no added/skipped words. If unsure of a word, stay silent with mouth closed — never switch language.`;

      prompt = `${opener} ${sceneLine} ${speechBlock}${voiceLine}${continuityLine}${pronLine} ${peopleLock} ${locks}${tailDialog}`;
    } else {
      // ── SILENT / VOICEOVER REENACTMENT ────────────────────────────────
      const opener = `REENACT THIS REFERENCE SHOT — reproduce the input image's scene exactly. The only thing you may change is the person's identity (use the face/body/skin/hair from the input image). Everything else (scene, camera, framing, lighting, pose, motion, wardrobe, props) must match the input image.`;

      const sceneLine = referenceBlock
        ? `SCENE TO REENACT: ${referenceBlock}`
        : `SCENE TO REENACT: reproduce exactly what the input image shows — same pose, same framing, same action implied by the input.`;

      const audioLine = isSilent
        ? `SILENCE: mouth stays CLOSED throughout the take — NO lip-sync, NO speech, NO singing, NO mouthing. AUDIO: ambient only, ZERO voices.`
        : `NO ON-CAMERA SPEECH: narration will be added in post — keep mouth relaxed and closed unless the input specifically shows it moving.`;

      const locks = combinedLockBlock(false);

      prompt = `${opener} ${sceneLine} ${audioLine} ${peopleLock} ${locks}`;
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
