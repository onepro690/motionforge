// Helpers pra buscar o mp4 direto do TikTok (via tikwm), transcrever com
// Whisper e analisar o vídeo inteiro com Gemini. Usado pelo pipeline pra
// copiar fielmente a fala (ou ausência) + a sequência visual do vídeo de
// referência.

import { prisma } from "@motion/database";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

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

function isRealSpeech(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  if (WHISPER_HALLUCINATIONS.has(trimmed)) return false;
  const clean = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  // Precisa de pelo menos 10 chars alfanuméricos — antes era 5, mas Whisper
  // frequentemente inventa frases curtas tipo "Obrigado." em vídeos só com
  // música. 10 chars filtra quase todas as alucinações sem perder fala real.
  return clean.length >= 10;
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

export interface TranscriptResult {
  text: string;
  hasSpeech: boolean;
  language?: string;
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

    const data = (await res.json()) as { text?: string; language?: string };
    const text = (data.text ?? "").trim();
    return {
      text,
      hasSpeech: isRealSpeech(text),
      language: data.language,
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
} | null> {
  const dv = await prisma.ugcDetectedVideo.findUnique({
    where: { id: detectedVideoId },
  });
  if (!dv) return null;

  // Já temos transcript cacheado? Reusa.
  if (dv.transcript !== null && dv.transcript !== undefined) {
    return {
      transcript: dv.transcript,
      hasSpeech: isRealSpeech(dv.transcript),
      playUrl: null,
    };
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
  };
}

// ── Frame extraction ────────────────────────────────────────────────────
// Extrai frames do vídeo de referência em intervalos iguais usando
// fluent-ffmpeg (mesma lib que o assembler, funciona no Vercel).
// Para um vídeo de 16s com 3 takes, extrai frames em ~2.7s, ~8s, ~13.3s
// — captura naturalmente cada segmento de roupa/cor diferente.

export interface ExtractedFrames {
  frames: Array<{ url: string; timestamp: number }>;
}

async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        console.error("[reference-video] ffprobe error:", err.message);
        reject(err);
        return;
      }
      const dur = data?.format?.duration ?? 0;
      console.log(`[reference-video] ffprobe duration=${dur}, format=${data?.format?.format_name}`);
      resolve(dur);
    });
  });
}

export async function extractKeyFrames(
  playUrl: string,
  videoId: string,
  targetCount: number = 3
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

    const duration = await getVideoDuration(videoPath);
    console.log(`[reference-video] video duration: ${duration}s`);
    if (duration <= 0) return null;

    // Divide o vídeo em partes iguais e pega o frame no meio de cada parte.
    // Para 3 takes de um vídeo de 16s: frames em ~2.7s, ~8s, ~13.3s
    const timestamps: number[] = [];
    for (let i = 0; i < targetCount; i++) {
      timestamps.push(((i + 0.5) / targetCount) * duration);
    }
    console.log(`[reference-video] extracting frames at: ${timestamps.map((t) => t.toFixed(1) + "s").join(", ")}`);

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
    return { frames };
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

export interface ReferenceVideoAnalysis {
  hasNarration: boolean;
  narrationStyle: "direct_speech" | "voiceover" | "none";
  narrationSummary: string;
  takeBreakdown: {
    take1: { timeRange: string; action: string; visuals: string };
    take2: { timeRange: string; action: string; visuals: string };
    take3: { timeRange: string; action: string; visuals: string };
  };
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
- A sequência temporal: o que aparece no início, meio e fim.
- Qual é a AÇÃO específica em cada terço do vídeo.

Retorne APENAS um JSON com esta estrutura:
{
  "hasNarration": true|false,
  "narrationStyle": "direct_speech" | "voiceover" | "none",
  "narrationSummary": "resumo do que a pessoa/narrador fala, ou string vazia se none",
  "takeBreakdown": {
    "take1": { "timeRange": "0-Xs", "action": "ação EXATA que a pessoa faz (ex: segura o vestido rosa na frente do corpo)", "visuals": "descrição DETALHADA do visual: cor EXATA da roupa/produto, posição da pessoa, objetos visíveis, fundo (ex: 'mulher segura vestido ROSA em cabide, fundo branco, espelho à esquerda')" },
    "take2": { "timeRange": "Xs-Ys", "action": "ação EXATA do meio do vídeo", "visuals": "visual DETALHADO incluindo cor/variante EXATA do produto neste momento (ex: 'mulher veste vestido AZUL, gira mostrando o caimento, mesma sala')" },
    "take3": { "timeRange": "Ys-fim", "action": "ação EXATA do final", "visuals": "visual DETALHADO incluindo cor/variante EXATA do produto neste momento (ex: 'mulher veste vestido PRETO, posa no espelho, sorri')" }
  },
  "keyVisualSequence": "descrição compacta da progressão visual do vídeo inteiro, citando CADA cor/variante na ordem exata",
  "productShownAs": "como o produto é mostrado (segurando, vestindo, demonstrando, etc)",
  "hasMultipleVariants": true|false,
  "variantDescription": "se hasMultipleVariants, descreva quais variantes NA ORDEM que aparecem, mapeando cada uma ao take (ex: 'take1: vestido rosa, take2: vestido azul, take3: vestido preto'). Se não, string vazia."
}

REGRAS CRÍTICAS:
- "direct_speech" = pessoa visível falando pra câmera com lip-sync.
- "voiceover" = narrador em off, pessoa não fala com a câmera.
- "none" = só música/ambient, ninguém fala.
- Se o áudio é SÓ música (mesmo com letra cantada) e ninguém narra o produto → "none".
- Se o vídeo mostra o produto em várias cores/variantes, SEMPRE marque hasMultipleVariants=true e descreva as variantes COM O TAKE onde cada uma aparece.
- CADA "visuals" de cada take DEVE descrever a COR ou VARIANTE EXATA do produto visível NAQUELE MOMENTO do vídeo. Nunca use descrições genéricas como "o produto" — diga "vestido ROSA", "tênis BRANCO", etc.
- Se o produto muda de cor/variante entre os takes, CADA take deve ter a cor correta daquele momento.
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
      return JSON.parse(match ? match[0] : text) as ReferenceVideoAnalysis;
    } catch (err) {
      console.error("[reference-video] failed to parse gemini JSON:", err, text.slice(0, 300));
      return null;
    }
  } catch (err) {
    console.error("[reference-video] gemini video request failed:", err);
    return null;
  }
}
