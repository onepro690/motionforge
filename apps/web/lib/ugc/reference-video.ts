// Helpers pra buscar o mp4 direto do TikTok (via tikwm) e transcrever com
// Whisper. Usado pelo pipeline pra copiar fielmente a fala (ou ausência de
// fala) do vídeo de referência.

import { prisma } from "@motion/database";

const TIKWM_API = "https://api.tikwm.com/api/";

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
    // Heurística pra "tem fala": 5+ caracteres alfanuméricos.
    const clean = text.replace(/[^\p{L}\p{N}]/gu, "");
    return {
      text,
      hasSpeech: clean.length >= 5,
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
    const clean = dv.transcript.replace(/[^\p{L}\p{N}]/gu, "");
    return {
      transcript: dv.transcript,
      hasSpeech: clean.length >= 5,
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
