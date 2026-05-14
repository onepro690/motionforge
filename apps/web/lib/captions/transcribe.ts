// Whisper word-level transcription pra legendas karaoke.
// Aceita path de áudio comprimido (mp3 ~32kbps mono) que cabe no limite de 24MB.

import { readFile } from "fs/promises";

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResult {
  language: string | null;
  duration: number | null;
  words: WhisperWord[];
}

export async function transcribeWords(audioPath: string): Promise<TranscribeResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[captions/transcribe] OPENAI_API_KEY não configurada");
    return null;
  }

  const bytes = await readFile(audioPath);
  if (bytes.byteLength > 24 * 1024 * 1024) {
    console.warn(`[captions/transcribe] áudio acima de 24MB (${bytes.byteLength}b) — Whisper recusa`);
    return null;
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  // Sem `language` → Whisper auto-detecta.

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("[captions/transcribe] whisper error:", res.status, txt.slice(0, 300));
    return null;
  }
  const data = (await res.json()) as {
    language?: string;
    duration?: number;
    words?: WhisperWord[];
  };

  return {
    language: data.language ?? null,
    duration: data.duration ?? null,
    words: data.words ?? [],
  };
}

export interface CaptionLine {
  start: number;
  end: number;
  words: WhisperWord[];
}

// Agrupa palavras em linhas pra karaoke. Cada linha vira um Dialogue ASS.
// Quebra agressiva pra ficar legível e seguir o ritmo da fala.
export function groupWordsIntoLines(words: WhisperWord[]): CaptionLine[] {
  const lines: CaptionLine[] = [];
  if (words.length === 0) return lines;

  const MAX_WORDS = 6;     // legibilidade — 4-6 é o sweet spot pra karaoke
  const MAX_CHARS = 36;    // cabe confortável em 9:16 e 16:9
  const MAX_DURATION = 4.0;
  const MAX_GAP = 1.2;     // pausa longa força quebra de linha

  let buf: WhisperWord[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    lines.push({
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      words: buf,
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const clean = w.word.trim();
    if (!clean) continue;

    const gapFromPrev = buf.length > 0 ? w.start - buf[buf.length - 1].end : 0;
    if (buf.length > 0 && gapFromPrev > MAX_GAP) {
      // pausa longa — começa nova linha antes desta palavra
      flush();
    }

    const wouldDuration = buf.length > 0 ? w.end - buf[0].start : 0;
    const wouldChars = bufChars + (bufChars > 0 ? 1 : 0) + clean.length;

    buf.push(w);
    bufChars = wouldChars;

    const endsWithStrong = /[.!?…]$/.test(clean);
    const endsWithSoft = /[,;:]$/.test(clean);

    if (
      buf.length >= MAX_WORDS ||
      bufChars >= MAX_CHARS ||
      wouldDuration >= MAX_DURATION ||
      endsWithStrong ||
      (endsWithSoft && buf.length >= 3)
    ) {
      flush();
    }
  }
  flush();
  return lines;
}
