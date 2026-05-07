// Generate animated burnt-in captions for the narrator pipeline.
//
// Pega o MP3 do TTS, transcreve com Whisper word-level, agrupa em chunks de
// 1-3 palavras (~600ms cada), e produz um arquivo ASS (Advanced SubStation
// Alpha) com legendas estilo TikTok viral: fonte gigante, MAIÚSCULAS, contorno
// preto grosso, pop scale + fade-in, palavras em destaque alternando entre
// branco / amarelo neon / dourado pra dar dinâmica.

import { readFile, writeFile } from "fs/promises";

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

async function transcribeWords(audioPath: string): Promise<WhisperWord[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const bytes = await readFile(audioPath);
  if (bytes.byteLength > 24 * 1024 * 1024) return null;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), "tts.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("language", "pt");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("[narrator/captions] whisper error:", res.status, txt.slice(0, 200));
    return null;
  }
  const data = (await res.json()) as { words?: WhisperWord[] };
  return data.words ?? null;
}

export interface DrawtextChunk {
  start: number;
  end: number;
  text: string;
}

type CaptionChunk = DrawtextChunk;

// Agrupa palavras em chunks curtos pra dar pegada viral (1-3 palavras por
// vez, max ~700ms). Quebra em pontuação ou quando atingir tamanho.
function chunkWords(words: WhisperWord[]): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  if (words.length === 0) return chunks;

  const MAX_WORDS = 3;
  const MAX_CHARS = 18; // pra caber bem na tela 9:16
  const MAX_DURATION = 0.85;

  let bufferWords: WhisperWord[] = [];
  let bufferLen = 0;

  const flush = () => {
    if (bufferWords.length === 0) return;
    const start = bufferWords[0].start;
    const end = bufferWords[bufferWords.length - 1].end;
    const text = bufferWords.map((w) => w.word.trim()).join(" ").trim();
    chunks.push({ start, end, text });
    bufferWords = [];
    bufferLen = 0;
  };

  for (const w of words) {
    const cleanWord = w.word.trim();
    if (!cleanWord) continue;
    const wouldDuration = bufferWords.length > 0 ? w.end - bufferWords[0].start : 0;
    const wouldChars = bufferLen + (bufferLen > 0 ? 1 : 0) + cleanWord.length;
    const endsWithPunct = /[.,!?;:…]$/.test(cleanWord);

    bufferWords.push(w);
    bufferLen = wouldChars;

    if (
      bufferWords.length >= MAX_WORDS ||
      bufferLen >= MAX_CHARS ||
      wouldDuration >= MAX_DURATION ||
      endsWithPunct
    ) {
      flush();
    }
  }
  flush();
  return chunks;
}

// ASS time format: H:MM:SS.cs (centisegundos)
function fmtTime(t: number): string {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t * 100) % 100);
  return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

// Cores ASS (formato &HBBGGRR) — alternamos pra dar dinâmica viral
const ACCENT_COLORS = [
  "&H00FFFFFF", // branco
  "&H0000F0FF", // amarelo dourado (BGR)
  "&H00FFFFFF", // branco
  "&H0066B5FF", // dourado
];

function escapeAssText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

// Constrói o arquivo ASS completo
function buildAss(chunks: CaptionChunk[], totalDurationSec: number): string {
  const lines: string[] = [];
  // Header
  lines.push("[Script Info]");
  lines.push("Title: Narrator viral captions");
  lines.push("ScriptType: v4.00+");
  lines.push("WrapStyle: 0");
  lines.push("ScaledBorderAndShadow: yes");
  lines.push("PlayResX: 1080");
  lines.push("PlayResY: 1920");
  lines.push("");

  lines.push("[V4+ Styles]");
  lines.push("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
  // Fonte "Liberation Sans Bold" geralmente disponível em Linux serverless;
  // ffmpeg cai num fallback se não achar. Tamanho 110 + bold + outline grosso
  // pra ficar bem TikTok-style.
  lines.push("Style: Viral,Liberation Sans,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,8,3,5,80,80,0,1");
  lines.push("");

  lines.push("[Events]");
  lines.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    // Estende a legenda ligeiramente até a próxima (sem gap visual)
    const next = chunks[i + 1];
    const visualEnd = next ? Math.min(next.start, c.end + 0.08) : Math.min(totalDurationSec, c.end + 0.18);
    const start = fmtTime(c.start);
    const end = fmtTime(visualEnd);

    const color = ACCENT_COLORS[i % ACCENT_COLORS.length];
    const dur = Math.max(0.1, visualEnd - c.start);
    const popMs = Math.min(180, Math.floor(dur * 1000 * 0.35));
    const fadeIn = Math.min(120, popMs);
    const fadeOut = 60;

    // Override tags:
    // \an5 = center anchor, \pos = posição
    // \fad(in,out) = fade
    // \t(0,popMs,\fscx115\fscy115) = pop scale (cresce de 100→115%)
    // \1c = primary color (palavra)
    // \3c = outline color (preto)
    // \bord = outline thickness
    // \shad = shadow
    // \b1 = bold
    const overrides = [
      "\\an5",
      "\\pos(540,1280)", // 540=center X (1080/2), 1280=2/3 da altura
      `\\fad(${fadeIn},${fadeOut})`,
      `\\t(0,${popMs},\\fscx118\\fscy118)`,
      `\\t(${popMs},${popMs + 80},\\fscx100\\fscy100)`,
      `\\1c${color}`,
      "\\3c&H00000000",
      "\\bord8",
      "\\shad3",
      "\\b1",
    ].join("");

    const text = escapeAssText(c.text.toUpperCase());
    lines.push(`Dialogue: 0,${start},${end},Viral,,0,0,0,,{${overrides}}${text}`);
  }

  return lines.join("\n");
}

export interface CaptionsBuildResult {
  wordsCount: number;
  chunks: DrawtextChunk[];
  assWritten: boolean;
}

export async function generateCaptionsAss(audioPath: string, totalDurationSec: number, outAssPath: string): Promise<CaptionsBuildResult> {
  try {
    const words = await transcribeWords(audioPath);
    if (!words || words.length === 0) {
      console.warn("[narrator/captions] whisper retornou 0 palavras");
      return { wordsCount: 0, chunks: [], assWritten: false };
    }
    console.log(`[narrator/captions] whisper words: ${words.length}, sample: ${words.slice(0, 5).map((w) => w.word).join("|")}`);
    const chunks = chunkWords(words);
    if (chunks.length === 0) {
      console.warn("[narrator/captions] nenhum chunk gerado");
      return { wordsCount: words.length, chunks: [], assWritten: false };
    }
    const ass = buildAss(chunks, totalDurationSec);
    await writeFile(outAssPath, ass, "utf8");
    return { wordsCount: words.length, chunks, assWritten: true };
  } catch (err) {
    console.error("[narrator/captions] generateCaptionsAss error:", err);
    return { wordsCount: 0, chunks: [], assWritten: false };
  }
}

// Helper exposto pra que o assemble use os mesmos chunks no fallback drawtext.
export function generateCaptionsDrawtext(words: WhisperWord[]): DrawtextChunk[] {
  return chunkWords(words);
}
