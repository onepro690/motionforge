// Helpers pra buscar o mp4 direto do TikTok (via tikwm), transcrever com
// Whisper e analisar o vídeo inteiro com Gemini. Usado pelo pipeline pra
// copiar fielmente a fala (ou ausência) + a sequência visual do vídeo de
// referência.

import { prisma } from "@motion/database";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Palavras/frases curtas que o Whisper inventa em vídeos silenciosos ou só
// com música. Se a transcrição for exatamente uma dessas, tratamos como
// SEM fala. Lista baseada nos hallucinations mais comuns do whisper-1.
const WHISPER_HALLUCINATIONS = new Set([
  "obrigado.", "obrigado", "obrigada.", "obrigada",
  "thank you.", "thank you", "thanks.", "thanks",
  "♪", "♪♪", "♪ ♪",
  "[música]", "[music]", "(música)", "(music)",
  ".", "..", "...",
  "legendado pela comunidade amara.org",
  "legendas pela comunidade amara.org",
  "subtitles by the amara.org community",
]);

// Segmentos do Whisper verbose_json — usados para detectar música vs fala real.
interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

// Analisa os segmentos do Whisper pra detectar se o áudio é música (não fala).
// Música tipicamente tem: segmentos longos ininterruptos, no_speech_prob alto,
// e/ou avg_logprob muito baixo (Whisper tem baixa confiança na transcrição).
// Thresholds agressivos pra evitar lip-sync de letra de música.
function isMusicNotSpeech(segments: WhisperSegment[]): boolean {
  if (!segments || segments.length === 0) return false;

  // Se uma fração razoável dos segmentos tem no_speech_prob alto, é música.
  // Baixei de 0.5 → 0.4 pra pegar vídeos com letra cantada que o Whisper
  // "transcreve" mas com sinal claro de não-fala.
  const highNoSpeech = segments.filter((s) => (s.no_speech_prob ?? 0) > 0.4);
  if (highNoSpeech.length >= segments.length * 0.5) {
    console.log(`[reference-video] music detected: ${highNoSpeech.length}/${segments.length} segments have no_speech_prob > 0.4`);
    return true;
  }

  // Se a maioria dos segmentos tem avg_logprob baixo, Whisper está chutando.
  // Baixei de -1.0 → -0.8 pra pegar letras cantadas (onde o modelo tem menos
  // confiança que em fala direta mas ainda produz texto).
  const lowConfidence = segments.filter((s) => (s.avg_logprob ?? 0) < -0.8);
  if (lowConfidence.length >= segments.length * 0.5) {
    console.log(`[reference-video] music detected: ${lowConfidence.length}/${segments.length} segments have avg_logprob < -0.8`);
    return true;
  }

  // Poucos segmentos longos cobrindo todo o áudio = provável música contínua
  // (fala real tem pausas naturais → mais segmentos curtos)
  if (segments.length <= 2) {
    const totalDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (totalDuration > 10) {
      const avgLen = totalDuration / segments.length;
      if (avgLen > 8) {
        console.log(`[reference-video] music detected: only ${segments.length} segments, avg ${avgLen.toFixed(1)}s each (likely continuous music)`);
        return true;
      }
    }
  }

  // Densidade de fala muito baixa — menos de 0.8 palavras por segundo em média.
  // Fala natural fica em 2-4 palavras/s; música cantada com letra simples
  // dá 0.3-0.8 palavras/s (letras repetitivas tipo "nananana").
  const totalDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (totalDuration > 8) {
    const totalWords = segments
      .map((s) => s.text.trim().split(/\s+/).filter(Boolean).length)
      .reduce((a, b) => a + b, 0);
    const wordsPerSec = totalWords / totalDuration;
    if (wordsPerSec < 0.8 && totalWords < totalDuration * 0.8) {
      console.log(`[reference-video] music detected: low speech density ${wordsPerSec.toFixed(2)} words/sec (totalWords=${totalWords}, duration=${totalDuration.toFixed(1)}s)`);
      return true;
    }
  }

  return false;
}

function isRealSpeech(text: string, segments?: WhisperSegment[]): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  if (WHISPER_HALLUCINATIONS.has(trimmed)) return false;
  const clean = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  // Precisa de pelo menos 10 chars alfanuméricos
  if (clean.length < 10) return false;
  // Se temos segmentos do Whisper, usa análise avançada pra filtrar música
  if (segments && isMusicNotSpeech(segments)) return false;
  return true;
}

const TIKWM_API = "https://www.tikwm.com/api/";

export interface TikwmDetail {
  playUrl: string | null;
  title: string;
  durationSeconds: number | null;
}

// Busca os detalhes do vídeo no tikwm usando a URL pública do TikTok.
// Retorna a URL direta do mp4 sem watermark (`play`).
export async function fetchTikwmDetail(tiktokUrl: string): Promise<TikwmDetail | null> {
  try {
    const res = await fetch(TIKWM_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: tiktokUrl, hd: "1" }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: number;
      data?: {
        play?: string;
        hdplay?: string;
        title?: string;
        duration?: number;
      };
    };
    if (data.code !== 0 || !data.data) return null;
    return {
      playUrl: data.data.hdplay ?? data.data.play ?? null,
      title: data.data.title ?? "",
      durationSeconds: typeof data.data.duration === "number" ? data.data.duration : null,
    };
  } catch (err) {
    console.error("[reference-video] tikwm fetch failed:", err);
    return null;
  }
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  hasSpeech: boolean;
  language?: string;
  segments?: TranscriptSegment[];
}

// Baixa o mp4 e manda pro Whisper. Retorna texto + flag indicando se tem
// fala real (considera silêncio/vazio quando texto < 5 chars úteis).
export async function transcribeVideoAudio(playUrl: string): Promise<TranscriptResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[reference-video] OPENAI_API_KEY not set — skipping transcription");
    return null;
  }

  try {
    const videoRes = await fetch(playUrl, { signal: AbortSignal.timeout(30000) });
    if (!videoRes.ok) {
      console.error("[reference-video] failed to download video:", videoRes.status);
      return null;
    }
    const videoBytes = await videoRes.arrayBuffer();
    // Whisper aceita até 25MB. TikToks curtos costumam ser muito menores.
    if (videoBytes.byteLength > 24 * 1024 * 1024) {
      console.warn("[reference-video] video too large for Whisper:", videoBytes.byteLength);
      return null;
    }

    const form = new FormData();
    form.append("file", new Blob([videoBytes], { type: "video/mp4" }), "ref.mp4");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[reference-video] whisper error:", res.status, err.slice(0, 300));
      return null;
    }

    const data = (await res.json()) as {
      text?: string;
      language?: string;
      segments?: WhisperSegment[];
    };
    const text = (data.text ?? "").trim();
    const segments = data.segments ?? [];
    const hasSpeech = isRealSpeech(text, segments);
    if (!hasSpeech && text.length > 0) {
      console.log(`[reference-video] audio classified as music/non-speech. Transcript: "${text.slice(0, 100)}". Segments: ${segments.length}, no_speech_probs: [${segments.map((s) => (s.no_speech_prob ?? 0).toFixed(2)).join(", ")}]`);
    }
    // Exporta segments com timestamps para split inteligente por take
    const cleanSegments: TranscriptSegment[] = hasSpeech
      ? segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text.length > 0)
      : [];

    return {
      text: hasSpeech ? text : "", // Limpa o texto se for música — avatar fica calado
      hasSpeech,
      language: data.language,
      segments: cleanSegments,
    };
  } catch (err) {
    console.error("[reference-video] transcribe error:", err);
    return null;
  }
}

// Pega ou cacheia a transcrição do detected video — salva em
// `UgcDetectedVideo.transcript` pra reutilizar em gerações futuras.
export async function ensureReferenceTranscript(detectedVideoId: string): Promise<{
  transcript: string;
  hasSpeech: boolean;
  playUrl: string | null;
  segments?: TranscriptSegment[];
} | null> {
  const dv = await prisma.ugcDetectedVideo.findUnique({
    where: { id: detectedVideoId },
  });
  if (!dv) return null;

  // Já temos transcript cacheado? Se for texto vazio (música/silêncio), reusa.
  // Se for texto com fala, RE-TRANSCREVE para obter os segments com timestamps
  // — precisamos dos timestamps do Whisper para split preciso por take.
  if (dv.transcript !== null && dv.transcript !== undefined) {
    if (!isRealSpeech(dv.transcript)) {
      // Música/silêncio — não precisa de segments
      return {
        transcript: dv.transcript,
        hasSpeech: false,
        playUrl: null,
      };
    }
    // Tem fala → re-transcreve para pegar segments com timestamps
  }

  // Precisa da URL pública do TikTok pra pegar o mp4 via tikwm.
  if (!dv.videoUrl) return null;
  const detail = await fetchTikwmDetail(dv.videoUrl);
  if (!detail?.playUrl) return null;

  const result = await transcribeVideoAudio(detail.playUrl);
  if (!result) return null;

  // Cacheia no DB. Usa string vazia pra "sem fala" — diferente de null
  // (não-tentado) semanticamente.
  await prisma.ugcDetectedVideo.update({
    where: { id: detectedVideoId },
    data: { transcript: result.text },
  }).catch(() => {});

  return {
    transcript: result.text,
    hasSpeech: result.hasSpeech,
    playUrl: detail.playUrl,
    segments: result.segments,
  };
}

// ── Scene detection via ffmpeg ──────────────────────────────────────────
// Detecta mudanças de cena (cortes, trocas de roupa, mudança de cor) usando
// o filtro `select='gt(scene,X)'` do ffmpeg. Retorna os timestamps dos
// pontos de corte. Mais preciso que intervalos iguais.

async function detectSceneChanges(videoPath: string, durationSeconds: number): Promise<number[]> {
  // ffmpeg scene detection: score 0-1, threshold 0.3 captura cortes claros
  // Testamos com threshold progressivamente mais baixo se não encontrar cortes
  const thresholds = [0.35, 0.25, 0.15];

  for (const threshold of thresholds) {
    try {
      const sceneTimestamps: number[] = [];
      const logPath = join(videoPath + `_scene_${threshold}.log`);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .outputOptions([
            "-vf", `select='gt(scene,${threshold})',showinfo`,
            "-vsync", "vfr",
            "-f", "null",
          ])
          .output("/dev/null")
          .on("stderr", (line: string) => {
            // showinfo outputs lines like: [Parsed_showinfo...] n:1 pts:12345 pts_time:3.456
            const match = line.match(/pts_time:([\d.]+)/);
            if (match) {
              const ts = parseFloat(match[1]);
              if (ts > 0.5 && ts < durationSeconds - 0.5) {
                sceneTimestamps.push(ts);
              }
            }
          })
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .run();
      });

      console.log(`[reference-video] scene detection (threshold=${threshold}): ${sceneTimestamps.length} cuts at [${sceneTimestamps.map(t => t.toFixed(1) + "s").join(", ")}]`);

      // Filtra timestamps muito próximos (<1.5s entre si) — mantém apenas o primeiro
      const filtered: number[] = [];
      for (const ts of sceneTimestamps) {
        if (filtered.length === 0 || ts - filtered[filtered.length - 1] > 1.5) {
          filtered.push(ts);
        }
      }

      if (filtered.length >= 1) {
        console.log(`[reference-video] scene changes after filtering: ${filtered.length} cuts`);
        return filtered;
      }
      // Se não encontrou cortes com este threshold, tenta o próximo
    } catch (err) {
      console.error(`[reference-video] scene detection failed (threshold=${threshold}):`, err);
    }
  }

  return []; // Nenhum corte detectado
}

// ── Frame extraction ────────────────────────────────────────────────────
// Extrai frames do vídeo de referência nos pontos de mudança de cena
// usando ffmpeg scene detection. Cada frame captura um momento visual
// distinto (roupa diferente, cenário diferente, corte diferente).

export interface ExtractedFrames {
  frames: Array<{ url: string; timestamp: number }>;
  detectedSceneCount: number; // Número de cenas detectadas pelo ffmpeg
}

export async function extractKeyFrames(
  playUrl: string,
  videoId: string,
  targetCount: number = 3,
  durationSeconds?: number | null
): Promise<ExtractedFrames | null> {
  const id = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `ugc-frames-${id}`);
  await mkdir(tmpDir, { recursive: true });
  const videoPath = join(tmpDir, "ref.mp4");
  const allFiles: string[] = [videoPath];

  try {
    console.log(`[reference-video] downloading video for frame extraction...`);
    const res = await fetch(playUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      console.error(`[reference-video] video download failed: ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[reference-video] downloaded ${buf.length} bytes`);
    await writeFile(videoPath, buf);

    const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : null;
    console.log(`[reference-video] video duration: ${duration ?? "unknown"}s`);
    if (!duration || duration <= 0) {
      console.error("[reference-video] no duration available — cannot extract frames");
      return null;
    }

    // Detecta pontos de corte/mudança de cena com ffmpeg
    const sceneChanges = await detectSceneChanges(videoPath, duration);
    // Número de cenas = cortes + 1 (a primeira cena começa no início)
    const detectedSceneCount = sceneChanges.length + 1;
    console.log(`[reference-video] detected ${detectedSceneCount} scenes (${sceneChanges.length} cuts)`);

    // Usa o maior entre targetCount (do pipeline) e detectedSceneCount (do ffmpeg)
    const actualCount = Math.max(targetCount, detectedSceneCount);

    // Calcula timestamps:
    // 1) Se temos cortes reais E targetCount <= cenas detectadas:
    //    → frame no MEIO de cada segmento entre cortes (captura cada roupa/cena)
    // 2) Se targetCount > cenas (ex: speech video 50s com 1 cena):
    //    → intervalos iguais ao longo do vídeo (frames espaçados pro speech)
    // 3) Se sem cortes:
    //    → intervalos iguais
    let timestamps: number[];
    if (sceneChanges.length > 0 && detectedSceneCount >= actualCount) {
      // Pontos de corte reais → frame a 40% do segmento (evita motion blur
      // dos dois lados — imediatamente após corte e antes do próximo corte
      // costumam ter zoom/motion que cortam a pessoa no frame).
      const boundaries = [0, ...sceneChanges, duration];
      timestamps = [];
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i];
        const end = boundaries[i + 1];
        timestamps.push(start + (end - start) * 0.4);
      }
    } else if (sceneChanges.length > 0 && actualCount > detectedSceneCount) {
      // Mais takes necessários que cenas detectadas (ex: speech video).
      // Usa cortes como base e adiciona frames extras em intervalos iguais.
      // Para speech: frames espaçados uniformemente cobrem todo o vídeo.
      timestamps = [];
      for (let i = 0; i < actualCount; i++) {
        timestamps.push(((i + 0.5) / actualCount) * duration);
      }
    } else {
      // Sem cortes → intervalos iguais
      timestamps = [];
      for (let i = 0; i < actualCount; i++) {
        timestamps.push(((i + 0.5) / actualCount) * duration);
      }
    }

    console.log(`[reference-video] extracting ${timestamps.length} frames at: ${timestamps.map((t) => t.toFixed(1) + "s").join(", ")}`);

    const frames: Array<{ url: string; timestamp: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = Math.min(timestamps[i], duration - 0.1);
      const framePath = join(tmpDir, `frame-${i}.jpg`);
      allFiles.push(framePath);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(ts)
          .frames(1)
          .outputOptions(["-q:v", "2"])
          .output(framePath)
          .on("end", () => resolve())
          .on("error", (err: Error) => {
            console.error(`[reference-video] frame ${i} extraction error at ${ts}s:`, err.message);
            reject(err);
          })
          .run();
      });

      const frameBuf = await readFile(framePath);
      console.log(`[reference-video] frame ${i} extracted: ${frameBuf.length} bytes at ${ts.toFixed(1)}s`);
      const blob = await put(`ugc-ref-frame-${videoId}-take${i + 1}.jpg`, frameBuf, {
        access: "public",
        contentType: "image/jpeg",
        addRandomSuffix: false,
      });
      frames.push({ url: blob.url, timestamp: ts });
    }

    console.log(`[reference-video] all ${frames.length} frames extracted and uploaded`);
    return { frames, detectedSceneCount };
  } catch (err) {
    console.error("[reference-video] frame extraction failed:", err);
    return null;
  } finally {
    await Promise.all(allFiles.map((p) => unlink(p).catch(() => {})));
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
}

// ── Gemini video understanding ───────────────────────────────────────────
// Manda o mp4 INTEIRO pro Gemini (não só 1 frame) pra descrever o que
// acontece ao longo do tempo. Isso resolve casos tipo "o vídeo mostra o
// vestido em 3 cores diferentes" — single-frame analysis só vê uma cor.

export interface SceneBreakdown {
  timeRange: string;
  action: string;
  visuals: string;
  // Quem fala nesta cena específica:
  // - "none"                = nenhuma fala humana (só música/ambiente)
  // - "solo"                = uma pessoa sozinha fala/lip-sync
  // - "group_unison"        = várias pessoas falam JUNTAS em uníssono (coro, gritaria)
  // - "multiple_alternating" = várias pessoas se alternam falando
  speakerMode?: "none" | "solo" | "group_unison" | "multiple_alternating";
  // Número aproximado de pessoas visíveis na cena (1, 2, 3+, crowd)
  peopleCount?: number;
  // true quando esta cena é continuação direta da cena anterior: MESMA(S)
  // pessoa(s), MESMO cenário/roupa — só corte editorial (outro ângulo,
  // outro momento da mesma fala). Pipeline reutiliza a imagem editada do
  // take anterior pra garantir identidade e cenário idênticos.
  continuesPreviousScene?: boolean;
}

export interface VoiceStyle {
  pitch: "low" | "medium" | "high";
  pace: "slow" | "medium" | "fast";
  energy: "calm" | "casual" | "enthusiastic" | "hyped";
  emotion: string;         // ex: "excited surprise", "confident", "chill"
  accentRegion: string;    // ex: "Brazilian Portuguese, São Paulo casual", "carioca"
  gender: "feminine" | "masculine" | "neutral";
  ageRange: string;        // ex: "young adult 20-30", "teen"
  description: string;     // resumo livre: "voz feminina jovem, animada, fala rápida, entonação ascendente no fim das frases, sotaque paulista casual"
}

export interface ReferenceVideoAnalysis {
  hasNarration: boolean;
  narrationStyle: "direct_speech" | "voiceover" | "none";
  narrationSummary: string;
  voiceStyle: VoiceStyle | null;
  sceneCount: number;
  scenes: SceneBreakdown[];
  keyVisualSequence: string;
  productShownAs: string;
  hasMultipleVariants: boolean;
  variantDescription: string;
}

export async function analyzeReferenceVideoWithGemini(
  playUrl: string,
  productName: string
): Promise<ReferenceVideoAnalysis | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.warn("[reference-video] GOOGLE_AI_API_KEY not set — skipping video analysis");
    return null;
  }

  try {
    const videoRes = await fetch(playUrl, { signal: AbortSignal.timeout(30000) });
    if (!videoRes.ok) return null;
    const videoBytes = await videoRes.arrayBuffer();
    if (videoBytes.byteLength > 18 * 1024 * 1024) {
      console.warn("[reference-video] video too large for inline Gemini:", videoBytes.byteLength);
      return null;
    }
    const base64 = Buffer.from(videoBytes).toString("base64");

    const instruction = `Você está analisando um vídeo UGC de TikTok Shop vendendo "${productName}". Assista ao vídeo INTEIRO e retorne um JSON descrevendo EXATAMENTE o que acontece.

Preste MUITA atenção:
- Se há narração falada humana (não música, não efeito sonoro, não música com letra).
- Se o vídeo mostra MÚLTIPLAS variantes do produto (cores, tamanhos, versões diferentes).
- QUANTAS CENAS DISTINTAS tem — cada troca de roupa, cor do produto, ou corte de cena conta como uma cena separada.
- A sequência temporal COMPLETA: o que aparece em CADA cena.

Retorne APENAS um JSON com esta estrutura:
{
  "hasNarration": true|false,
  "narrationStyle": "direct_speech" | "voiceover" | "none",
  "narrationSummary": "resumo do que a pessoa/narrador fala, ou string vazia se none",
  "voiceStyle": {
    "pitch": "low" | "medium" | "high",
    "pace": "slow" | "medium" | "fast",
    "energy": "calm" | "casual" | "enthusiastic" | "hyped",
    "emotion": "descrição curta da emoção dominante (ex: 'animação genuína', 'confiança casual', 'surpresa empolgada', 'explicação séria')",
    "accentRegion": "sotaque / região do português brasileiro (ex: 'paulista casual', 'carioca', 'nordestino', 'português neutro')",
    "gender": "feminine" | "masculine" | "neutral",
    "ageRange": "faixa etária aparente pela voz (ex: 'jovem adulta 20-30', 'adolescente 15-20', 'adulta 30-40')",
    "description": "descrição LIVRE e DETALHADA do jeito de falar: tom, ritmo, pausas, entonação, ênfases, tiques verbais, cadência, volume. Seja específico — isto vai ser usado pra replicar a voz. Ex: 'voz feminina jovem, animada, fala rápida, entonação ascendente no fim das frases com emoção genuína, sotaque paulista casual, enfatiza adjetivos esticando a vogal (MUI-to bom)'"
  },
  "sceneCount": N,
  "scenes": [
    { "timeRange": "0-Xs", "action": "ação EXATA (ex: segura o vestido rosa na frente do corpo)", "visuals": "visual DETALHADO: cor EXATA da roupa/produto, posição da pessoa, objetos, fundo (ex: 'mulher segura vestido ROSA em cabide, fundo branco, espelho à esquerda')", "peopleCount": N, "speakerMode": "none" | "solo" | "group_unison" | "multiple_alternating", "continuesPreviousScene": false },
    { "timeRange": "Xs-Ys", "action": "ação EXATA da segunda cena", "visuals": "visual DETALHADO com cor/variante EXATA (ex: 'mulher veste vestido AZUL, gira mostrando o caimento')", "peopleCount": N, "speakerMode": "...", "continuesPreviousScene": true|false }
  ],
  "keyVisualSequence": "descrição compacta da progressão visual do vídeo inteiro, citando CADA cor/variante na ordem exata",
  "productShownAs": "como o produto é mostrado (segurando, vestindo, demonstrando, etc)",
  "hasMultipleVariants": true|false,
  "variantDescription": "se hasMultipleVariants, descreva quais variantes NA ORDEM que aparecem (ex: 'cena 1: vestido rosa, cena 2: vestido azul, cena 3: vestido preto, cena 4: vestido branco'). Se não, string vazia."
}

REGRAS CRÍTICAS:
- "direct_speech" = pessoa visível falando pra câmera com lip-sync.
- "voiceover" = narrador em off, pessoa não fala com a câmera.
- "none" = só música/ambient, ninguém fala.
- Se o áudio é SÓ música (mesmo com letra cantada) e ninguém narra o produto → "none".
- Quando hasNarration=true, voiceStyle DEVE ser preenchido ouvindo o áudio REAL do vídeo. Não use valores genéricos — analise pitch, cadência, entonação, energia, sotaque COMO ELES REALMENTE SOAM. Quando hasNarration=false, voiceStyle=null.
- "sceneCount" = número TOTAL de cenas distintas. Se o vídeo mostra 4 roupas diferentes, sceneCount=4. Se mostra 2 ângulos do mesmo look, sceneCount=2. CONTE EXATAMENTE quantas cenas tem.
- O array "scenes" DEVE ter EXATAMENTE sceneCount elementos — um por cena. NÃO agrupe cenas. Se tem 4 trocas de roupa, retorne 4 cenas, NÃO 3.
- CADA "visuals" de cada cena DEVE descrever a COR ou VARIANTE EXATA do produto visível NAQUELE MOMENTO do vídeo. Nunca use descrições genéricas — diga "vestido ROSA", "tênis BRANCO", etc.
- "peopleCount" de cada cena = quantas pessoas aparecem VISIVELMENTE na cena (use 5 se for multidão/coro).
- "speakerMode" de cada cena (CRÍTICO — observe com atenção):
   * "none"                = ninguém está falando nesta cena (só música/ação)
   * "solo"                = UMA pessoa sozinha fala/faz lip-sync para a câmera
   * "group_unison"        = DUAS OU MAIS pessoas falam/gritam JUNTAS a mesma coisa ao mesmo tempo (coro, gritaria sincronizada)
   * "multiple_alternating" = VÁRIAS pessoas se alternam falando (cada uma fala sua parte)
  → Se a cena mostra 5 pessoas todas gritando "MOMOMOMO" juntas, isso é "group_unison", NÃO "solo".
- "continuesPreviousScene" (CRÍTICO — observe com atenção):
   * true  = esta cena é continuação DIRETA da cena anterior — MESMA(S) pessoa(s), MESMO cenário/fundo, MESMA roupa, só um corte editorial (câmera mudou de ângulo, pulou alguns segundos, mas é a mesma tomada da mesma pessoa continuando a mesma fala/ação).
   * false = esta cena introduz pessoa(s) nova(s), cenário novo, ou troca de roupa/look — é uma cena visualmente distinta da anterior.
   → Ex: se cena 2 mostra uma mulher solo falando na cozinha e cena 3 mostra a MESMA mulher falando na MESMA cozinha (só outro ângulo ou continuação da mesma fala), cena 3 tem continuesPreviousScene=true.
   → Ex: se cena 2 é um grupo gritando e cena 3 é UMA pessoa solo em outro cenário, cena 3 tem continuesPreviousScene=false.
   → A primeira cena SEMPRE tem continuesPreviousScene=false.
   → Seja PRECISO: só marque true quando for literalmente a mesma pessoa no mesmo cenário/roupa. Na dúvida, marque false.
- Se o vídeo mostra o produto em várias cores/variantes, SEMPRE marque hasMultipleVariants=true.
- Retorne APENAS o JSON, sem markdown, sem explicação.`;

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
              { inlineData: { mimeType: "video/mp4", data: base64 } },
              { text: instruction },
            ],
          }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[reference-video] gemini video error:", res.status, err.slice(0, 300));
      return null;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;

    try {
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text) as ReferenceVideoAnalysis & { takeBreakdown?: Record<string, SceneBreakdown> };

      // Backward compat: se Gemini retornou o formato antigo takeBreakdown, converte pra scenes
      if (!parsed.scenes && parsed.takeBreakdown) {
        parsed.scenes = Object.values(parsed.takeBreakdown);
        parsed.sceneCount = parsed.scenes.length;
      }
      // Garante que sceneCount bate com scenes.length
      if (parsed.scenes) {
        parsed.sceneCount = parsed.scenes.length;
      } else {
        parsed.scenes = [];
        parsed.sceneCount = 0;
      }

      console.log(`[reference-video] Gemini analysis: ${parsed.sceneCount} scenes, narration=${parsed.narrationStyle}`);
      return parsed;
    } catch (err) {
      console.error("[reference-video] failed to parse gemini JSON:", err, text.slice(0, 300));
      return null;
    }
  } catch (err) {
    console.error("[reference-video] gemini video request failed:", err);
    return null;
  }
}
