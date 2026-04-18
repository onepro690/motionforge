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
  // O vídeo de referência é a fonte da verdade. A única variável liberada
  // é a identidade da pessoa (trocada pelo avatar via input image).
  // Clauses abaixo são imperativas e proibitivas — Veo 3 precisa ouvir
  // "não invente" mais alto do que "faça isso".
  // ──────────────────────────────────────────────────────────────────────

  // Abertura universal: reenactment mode. Aparece PRIMEIRO em todo prompt.
  const reenactmentHeader = `REENACTMENT MODE — reproduce the reference shot with maximum fidelity. The input image is a single frame of the exact scene you must recreate. Do NOT reinterpret, do NOT invent new framing, do NOT invent new backgrounds, do NOT invent new motion, do NOT invent new actions, do NOT add or remove people. The ONLY variable you are allowed to change is the human identity — use the face, body, skin tone, and hair from the input image. EVERYTHING else (scene, camera, framing, lighting, pose timing, motion, wardrobe, props) must match the input image and the reference description below.`;

  // Scene lock: fundo/câmera/enquadramento/composição bloqueados.
  const sceneLock = `SCENE LOCK: background, environment, camera angle, camera distance, lens feel, lighting direction and intensity, shadows, color grading, composition, and depth of field are FIXED by the input image. Do NOT change any of these. No new rooms, no new walls, no new furniture, no new props. If the input image shows a plain backdrop, keep it plain. If it shows a specific location, stay in that location.`;

  // Color lock: anti-drift entre takes encadeadas. Veo tende a adicionar
  // warm/yellow/sepia a cada geração quando alimentado com seu próprio frame,
  // acumulando ao longo da cadeia. Essa clausula trava white balance no input.
  const colorLock = `COLOR LOCK: preserve the EXACT color grading, white balance, saturation, contrast, exposure, sharpness, and skin tone of the input image with ZERO drift. Do NOT add warm tones, do NOT add yellow tint, do NOT add sepia, do NOT add amber, do NOT add orange cast, do NOT add a "cinematic" or "film" look, do NOT add teal-and-orange, do NOT boost saturation, do NOT boost contrast, do NOT sharpen, do NOT soften, do NOT shift white balance cooler or warmer. Skin tone must stay identical in hue and lightness to the input image — do NOT tan, do NOT redden, do NOT yellow. The output must look like it was shot by the exact same camera with the exact same color profile as the input image. Neutral whites in the input image must remain neutral whites in the output (same RGB balance).`;

  // Identity lock (já existia, reforçado).
  const identityLock = `IDENTITY LOCK: the person's face and body must match the input image PIXEL-IDENTICAL — same face shape, same facial features, same skin tone, same hair color/style/length, same eye color, same ethnicity, same body proportions, same age. Do NOT morph, do NOT drift, do NOT reinterpret. The identity is fixed by the input image and must stay 100% identical from the first frame to the last frame of this take and across every other take.`;

  // Anti-freedom clause: lista explícita do que é PROIBIDO.
  const forbidList = `FORBIDDEN: inventing a new scene, adding extra people not in the input image, removing people who are in the input image, changing the camera angle, zooming in or out beyond the input image's framing, adding text/captions/subtitles/watermarks/logos, changing the outfit mid-take, changing the background mid-take, morphing the face, drifting body proportions, adding tattoos or piercings or scars not visible in the input image.`;

  // Texto queimado na tela é o erro #1 recorrente do Veo 3: ele lê o script
  // falado e reenderiza as palavras como legenda/caption estilo TikTok. Essa
  // cláusula é dedicada e vai repetida NO COMEÇO e no final do prompt pra
  // afogar essa tendência. Testes mostraram que só "no text" no forbidList
  // é fraco — precisa ser explícito e redundante.
  const noTextLock = `ZERO ON-SCREEN TEXT: do NOT burn any text, captions, subtitles, closed captions, auto-subtitles, speech-to-text overlays, TikTok/Instagram-style animated captions, title cards, lower thirds, watermarks, usernames, hashtags, emojis, price tags, product labels rendered as graphics, typography, letters, numbers, or any written characters onto the video frame. The dialogue is SPOKEN audio only — it must NEVER appear as visible writing. The output video must be 100% free of any graphical text overlay. If the reference video had captions, do NOT reproduce them. Product labels that are physically printed on real objects in-scene are fine; anything rendered as a video overlay or caption is FORBIDDEN.`;

  // Aspect ratio lock: força 9:16 nativo. Veo 3 às vezes recebe um frame de
  // input landscape (mesmo depois do crop no ffmpeg) e "preserva" a framing
  // do input, resultando em letterbox (barras pretas em cima e embaixo).
  // Essa cláusula instrui a preencher os 9:16 inteiros, sem padding.
  const aspectLock = `ASPECT RATIO LOCK: the output video MUST fill the entire 9:16 vertical frame edge-to-edge. NO black bars on top or bottom. NO letterboxing. NO pillarboxing. NO side bars. The scene must extend to fill every pixel of the 9:16 canvas. If the input image is landscape, reframe it as a tight vertical capture of the same person/scene — do NOT shrink it with black padding. Native vertical smartphone capture feel.`;

  const anatomyShort = `Anatomy correct: no cut-off limbs, no clipping through furniture, no fused hands or extra fingers. Keep the full head and upper body inside the frame throughout the take — no zoom-in crops, no head chopping, no body parts disappearing off-screen, stable framing as shown in the input image.`;

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
      // ── SPEECH_EXACT_REENACTMENT_MODE ─────────────────────────────────
      // Fala literal do vídeo original + reprodução rígida do visual.
      const speakerMode = spec?.exactSpeaker ?? sceneForTake?.speakerMode ?? "solo";
      const visualsText = (sceneForTake?.visuals ?? spec?.exactVisuals ?? "").toLowerCase() + " " + (sceneForTake?.action ?? spec?.exactAction ?? "").toLowerCase();
      const looksLikeGroup = /\b(grupo|várias pessoas|varias pessoas|muita gente|multidão|multidao|coro|crowd|group|together|juntas|juntos|todos|todas|em uníssono|em unissono)\b/.test(visualsText);
      const effectiveMode = speakerMode !== "solo" && speakerMode !== "none" ? speakerMode : (looksLikeGroup ? "group_unison" : "solo");
      const wordCount = takeScript.split(/\s+/).filter(Boolean).length;
      const peopleCount = spec?.peopleCount ?? sceneForTake?.peopleCount ?? 1;

      // Speech block FIRST — Veo 3 prioriza o começo. Linguagem EXATA, sem parafraseio.
      let speechBlock: string;
      if (effectiveMode === "group_unison") {
        const pc = peopleCount > 1 ? peopleCount : 0;
        speechBlock = `${reenactmentHeader} Vertical 9:16 UGC video. ${pc > 0 ? `EXACTLY ${pc} people` : "Multiple people"} visible in the input image speak IN UNISON (all together, synchronized) directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR). They say LITERALLY these ${wordCount} words, word-for-word, no paraphrasing, no additions, no removals, no translations, no substitutions, no English, no mumbling: "${takeScript}". Pronounce every word exactly as written. After the last word they close their mouths and stop — do NOT add any extra speech. AUDIO TRACK: ONLY the group's voices speaking this exact Portuguese text — ZERO background music, ZERO sound effects, ZERO other languages, ZERO singing.`;
      } else if (effectiveMode === "multiple_alternating") {
        speechBlock = `${reenactmentHeader} Vertical 9:16 UGC video. Multiple people visible in the input image take turns speaking directly to camera with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR), preserving the reference video's alternation and timing. Across all speakers they say LITERALLY these ${wordCount} words, word-for-word, no paraphrasing, no additions, no removals, no translations: "${takeScript}". Pronounce every word exactly as written. After the last word they close their mouths and stop. AUDIO TRACK: ONLY the speakers' voices speaking this exact Portuguese text — ZERO music, ZERO sound effects, ZERO other languages.`;
      } else {
        speechBlock = `${reenactmentHeader} Vertical 9:16 UGC video. The person in the input image speaks DIRECTLY TO CAMERA with natural lip-sync in BRAZILIAN PORTUGUESE (pt-BR). They say LITERALLY these ${wordCount} words, word-for-word, no paraphrasing, no additions, no removals, no translations, no English, no mumbling: "${takeScript}". Pronounce every word exactly as written. Start speaking within the first 0.3 seconds. Finish the last word before the take ends. After the last word close the mouth and stop — do NOT add any extra speech. AUDIO TRACK: ONLY the person's voice speaking this exact Portuguese text — ZERO background music, ZERO sound effects, ZERO other voices, ZERO other languages, ZERO singing.`;
      }

      prompt = `${noTextLock} ${aspectLock} ${speechBlock} ${peopleLock} ${referenceBlock} ${sceneLock} ${colorLock} ${identityLock} ${forbidList} ${anatomyShort} ${noTextLock}`;

      // Pronunciation (opcional)
      if (/\bcarrinho\b/i.test(takeScript)) {
        prompt += ` Pronounce "carrinho" with strong aspirated RR (kah-HEE-nyoo), NOT soft R (kah-REE-nyoo = different word).`;
      }

      // Voice style: espelha EXATAMENTE a voz do original (não adapte, não generalize).
      if (voiceStyle) {
        prompt += ` Voice must match the reference voice EXACTLY: ${voiceStyle.gender}, ${voiceStyle.ageRange}, ${voiceStyle.pitch} pitch, ${voiceStyle.pace} pace, ${voiceStyle.energy} energy, ${voiceStyle.emotion} emotion, ${voiceStyle.accentRegion} accent. Preserve the same intonation, rhythm, pauses, and emphasis heard in the reference video. Do NOT add new vocal patterns. Keep the SAME voice in every take.`;
      }

      // Emoção da TAKE_SPEC (se derivada do Gemini voiceStyle)
      if (spec?.exactEmotion) {
        prompt += ` Emotional intent for this take: ${spec.exactEmotion}. Preserve it exactly — do not escalate or soften.`;
      }

      // Continuidade: respeita transição real do vídeo original.
      if (takeCount > 1 && spec) {
        if (spec.transitionIn === "continuous") {
          prompt += ` Start in the same pose/position as the previous take's last frame — continuous flow from the prior take.`;
        } else if (spec.transitionIn === "hard_cut" && i > 0) {
          prompt += ` This take follows a HARD CUT from the previous take — begin in the pose/framing of this take's input image, NOT from the previous take's end frame.`;
        }
        if (spec.transitionOut === "continuous" && i < takeCount - 1) {
          prompt += ` End still mid-conversation — do not pause or conclude; the next take continues the flow.`;
        } else if (i === takeCount - 1) {
          prompt += ` This is the final take — end cleanly.`;
        }
      }

      // Tail reinforcement: Veo pesa começo E fim do prompt. Repetimos o
      // texto literal no final pra bloquear qualquer tendência de improvisar
      // palavras diferentes ou parafrasear no meio da fala.
      prompt += ` FINAL DIALOG LOCK: the spoken line in this take is EXACTLY this Brazilian Portuguese text and nothing else: "${takeScript}". Do not add words, do not skip words, do not translate, do not paraphrase, do not change order, do not substitute synonyms. Every syllable must match.`;
    } else {
      // ── FASHION_SILENT_EXACT_MATCH_MODE / VOICEOVER ────────────────────
      // Vídeo silencioso: boca fechada, cenário fixo, só a pessoa é trocada.
      // Aqui a fidelidade ao original é a coisa mais importante — não há
      // fala pra distrair o Veo, então ele tende a "inventar" cenário
      // quando deixado sem instrução rígida. Header silent PRIMEIRO.
      const silentHeader = isSilent
        ? `${reenactmentHeader} Vertical 9:16 UGC video — ABSOLUTELY SILENT reenactment. The person's MOUTH MUST STAY CLOSED throughout the entire take — NO lip-sync, NO dialogue, NO speech, NO voiceover in any language, NO singing, NO whispering, NO mouthing of words. The person NEVER speaks and NEVER moves their lips in a way that implies speech. AUDIO TRACK: only the ambient/music feel of the reference — ZERO voices.`
        : `${reenactmentHeader} Vertical 9:16 UGC video. No on-camera speech in this take — the narration will be added as voice-over in post. Keep the mouth relaxed and closed unless the reference specifically shows it moving.`;

      prompt = `${noTextLock} ${aspectLock} ${silentHeader} ${peopleLock} ${referenceBlock} ${sceneLock} ${colorLock} ${identityLock} ${forbidList} ${anatomyShort} ${noTextLock}`;

      // Para takes silent, o raw do GPT-4o é descartado — só rebaixa a
      // densidade do prompt e pode introduzir linguagem generativa.
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
