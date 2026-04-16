// Server-side TTS for UGC narration
// Uses OpenAI TTS (same key already used in the project)
// Returns MP3 audio buffer and uploads to Vercel Blob

import { put } from "@vercel/blob";

export async function generateNarration(
  script: string,
  voice: string = "nova",
  videoId: string
): Promise<string | null> {
  if (!script || !script.trim()) {
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[ugc/tts] OPENAI_API_KEY not set — skipping audio generation");
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: script,
        voice,
        response_format: "mp3",
        speed: 1.02,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[ugc/tts] OpenAI TTS error:", err);
      return null;
    }

    const buffer = await res.arrayBuffer();
    const blob = await put(`ugc-audio-${videoId}.mp3`, Buffer.from(buffer), {
      access: "public",
      contentType: "audio/mpeg",
      addRandomSuffix: false,
    });

    return blob.url;
  } catch (err) {
    console.error("[ugc/tts] Error generating narration:", err);
    return null;
  }
}

// Available OpenAI TTS voices
export const TTS_VOICES = [
  { id: "nova", name: "Nova (feminino, jovem)" },
  { id: "shimmer", name: "Shimmer (feminino, suave)" },
  { id: "alloy", name: "Alloy (neutro)" },
  { id: "echo", name: "Echo (masculino, suave)" },
  { id: "fable", name: "Fable (masculino, britânico)" },
  { id: "onyx", name: "Onyx (masculino, profundo)" },
] as const;
