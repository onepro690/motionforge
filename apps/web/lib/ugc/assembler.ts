// Server-side video assembly for UGC takes
// Reuses fluent-ffmpeg + @ffmpeg-installer/ffmpeg (already in the project)
// Merges multiple Veo3 takes with optional audio narration

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";
import { execFile } from "child_process";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Get video duration using ffmpeg (no ffprobe needed)
function getVideoDurationFfmpeg(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    const proc = execFile(ffmpegInstaller.path, ["-i", videoPath, "-f", "null", "-"], { timeout: 15000 });
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const centis = parseInt(match[4]);
        resolve(hours * 3600 + minutes * 60 + seconds + centis / 100);
      } else {
        resolve(0);
      }
    });
    proc.on("error", () => resolve(0));
  });
}

interface TakeInfo {
  url: string;
  durationSeconds?: number;
  intendedScript?: string | null;
}

export interface SpeechCoverage {
  expectedWords: number;
  foundWords: number;
  coverage: number;     // 0..1
  missingWords: string[];
}

export interface AssemblyResult {
  finalVideoUrl: string;
  durationSeconds: number;
  coverage?: SpeechCoverage | null;
}

// Download a file from URL to a temp path
async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  await writeFile(destPath, Buffer.from(buffer));
}

// Concatenate multiple MP4 files com acrossfade de 30ms entre os áudios.
// Vídeo: concat duro (sem fade visual — queremos o corte limpo).
// Áudio: acrossfade curto elimina o "pop" na fronteira do corte (problema
// típico quando o Veo gera tomadas com níveis de ruído de fundo diferentes).
// Para 1 input, só copia.
async function concatVideos(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error("concatVideos: no inputs");
  }

  // Caso único: só re-muxa para garantir +faststart
  if (inputPaths.length === 1) {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPaths[0])
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return;
  }

  // Monta filter_complex: concat de vídeo + cadeia de acrossfade no áudio.
  // Cada acrossfade encurta o áudio em FADE segundos por par — com FADE=0.03 e
  // N takes, drift total = (N-1)*30ms (ex: 4 takes = 90ms). Aceitável.
  const FADE = 0.03;
  const videoLabels = inputPaths.map((_, i) => `[${i}:v]`).join("");
  const concatFilter = `${videoLabels}concat=n=${inputPaths.length}:v=1:a=0[vout]`;

  const audioChain: string[] = [];
  let currentAudio = `[0:a]`;
  for (let i = 1; i < inputPaths.length; i++) {
    const outLabel = i === inputPaths.length - 1 ? `[aout]` : `[a${i}]`;
    audioChain.push(`${currentAudio}[${i}:a]acrossfade=d=${FADE}:c1=tri:c2=tri${outLabel}`);
    currentAudio = outLabel;
  }

  const filterComplex = [concatFilter, ...audioChain].join(";");

  try {
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg();
      for (const p of inputPaths) cmd.input(p);
      cmd
        .complexFilter(filterComplex)
        .outputOptions([
          "-map", "[vout]",
          "-map", "[aout]",
          "-c:v", "libx264",
          "-c:a", "aac",
          "-movflags", "+faststart",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  } catch (err) {
    // Fallback: se o filter_complex falhar (ex: take sem faixa de áudio),
    // cai pro concat demuxer clássico.
    console.error("[assembler.concatVideos] filter_complex failed, falling back to demuxer:", err);
    const listPath = outputPath + ".list.txt";
    const listContent = inputPaths.map((p) => `file '${p}'`).join("\n");
    await writeFile(listPath, listContent, "utf8");
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (e: Error) => reject(e))
        .run();
    });
    await unlink(listPath).catch(() => {});
  }
}

// Substitui o áudio do vídeo pela narração. Antes a gente mixava 20% do
// áudio do Veo + 100% da narração, mas isso causava voz dupla — o Veo já
// gera lip-sync com voz própria. Agora trocamos completo pela faixa de TTS.
async function mixAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-movflags", "+faststart",
        "-shortest",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

// Get video duration in seconds
async function getVideoDuration(videoPath: string): Promise<number> {
  return getVideoDurationFfmpeg(videoPath);
}

// Trim trailing silence from a video.
// Uses ffmpeg silencedetect to find where speech ends, then trims.
// Keeps a small buffer (0.15s) after last speech for natural ending.
async function trimTrailingSilence(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    // Detect silence periods using ffmpeg — mais sensível (-35dB, 0.3s) pra
    // pegar pausas mais curtas no final do take
    const silenceInfo = await new Promise<string>((resolve) => {
      let stderr = "";
      ffmpeg(inputPath)
        .audioFilters("silencedetect=noise=-35dB:d=0.3")
        .format("null")
        .output(process.platform === "win32" ? "NUL" : "/dev/null")
        .on("stderr", (line: string) => { stderr += line + "\n"; })
        .on("end", () => resolve(stderr))
        .on("error", () => resolve(stderr))
        .run();
    });

    // Parse silence_end timestamps — find the last one
    const silenceEndMatches = [...silenceInfo.matchAll(/silence_end:\s*([\d.]+)/g)];
    const duration = await getVideoDurationFfmpeg(inputPath);

    if (silenceEndMatches.length === 0 || duration <= 0) {
      // No silence detected or can't get duration — use original
      return false;
    }

    const lastSpeechEnd = parseFloat(silenceEndMatches[silenceEndMatches.length - 1][1]);
    const trimPoint = Math.min(lastSpeechEnd + 0.15, duration); // 0.15s buffer (antes 0.3s)

    // Only trim if there's significant trailing silence (>0.4s) — antes 0.8s
    if (duration - trimPoint < 0.4) return false;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(trimPoint)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return true;
  } catch (err) {
    console.error("[assembler] trimTrailingSilence error:", err);
    return false;
  }
}

// ── Whisper-based extra-speech trimmer ─────────────────────────────────────
// Veo 3 às vezes alucina palavras extras no final do take (ex: script termina
// em "na bio" mas o Veo continua falando "...e é incrível"). Transcrevemos
// o take com timestamps por palavra, comparamos com o script esperado, e
// cortamos o vídeo quando o avatar passa a falar palavras que NÃO estavam
// no script.

function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^\p{L}\p{N}]/gu, ""); // strip punctuation
}

interface WhisperWord { word: string; start: number; end: number }

async function transcribeWordsWithWhisper(videoPath: string): Promise<WhisperWord[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const bytes = await readFile(videoPath);
    if (bytes.byteLength > 24 * 1024 * 1024) return null;

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), "take.mp4");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error("[assembler] whisper error:", res.status, err.slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { words?: Array<{ word: string; start: number; end: number }> };
    return data.words?.map((w) => ({ word: w.word, start: w.start, end: w.end })) ?? null;
  } catch (err) {
    console.error("[assembler] transcribeWordsWithWhisper error:", err);
    return null;
  }
}

// Acha o índice da última palavra do script dentro da transcrição.
// Usa janela deslizante (últimas 2-4 palavras do script) pra ser robusto a
// palavras extras antes ou depois. Retorna o índice na transcrição onde o
// script termina, ou -1 se não conseguir localizar.
function findScriptEndInTranscript(scriptWords: string[], transcribedWords: string[]): number {
  if (scriptWords.length === 0 || transcribedWords.length === 0) return -1;

  const normScript = scriptWords.map(normalizeWord).filter((w) => w.length > 0);
  const normTrans = transcribedWords.map(normalizeWord);
  if (normScript.length === 0) return -1;

  const lastWord = normScript[normScript.length - 1];

  // Estratégia 1: match janela das últimas 3 palavras
  const tail = normScript.slice(-3);
  for (let i = normTrans.length - tail.length; i >= 0; i--) {
    let allMatch = true;
    for (let j = 0; j < tail.length; j++) {
      if (normTrans[i + j] !== tail[j]) { allMatch = false; break; }
    }
    if (allMatch) return i + tail.length - 1;
  }

  // Estratégia 2: match só da última palavra (do final pro começo)
  for (let i = normTrans.length - 1; i >= 0; i--) {
    if (normTrans[i] === lastWord) return i;
  }

  return -1;
}

// Transcreve o take, compara com o script esperado, corta vídeo se houver
// palavras extras depois do último word do script. Também corta se o take
// começa com silêncio antes da fala (head trim). Retorna true se cortou.
async function trimToScript(inputPath: string, outputPath: string, intendedScript: string): Promise<boolean> {
  try {
    const trimmed = intendedScript.trim();
    if (trimmed.length === 0) return false;

    const words = await transcribeWordsWithWhisper(inputPath);
    if (!words || words.length === 0) {
      console.log("[assembler.trimToScript] no whisper words, skipping");
      return false;
    }

    const scriptWords = trimmed.split(/\s+/).filter(Boolean);
    const transcribedTokens = words.map((w) => w.word);
    const endIdx = findScriptEndInTranscript(scriptWords, transcribedTokens);

    if (endIdx < 0) {
      console.log(`[assembler.trimToScript] could not locate script end in transcript. Script last words: "${scriptWords.slice(-3).join(" ")}", transcribed: "${transcribedTokens.slice(-5).join(" ")}"`);
      return false;
    }

    const duration = await getVideoDurationFfmpeg(inputPath);
    if (duration <= 0) return false;

    const endWord = words[endIdx];
    const cutAt = Math.min(endWord.end + 0.2, duration); // 0.2s de buffer
    const extraWordsAfter = transcribedTokens.length - 1 - endIdx;
    const trailingCut = duration - cutAt;

    // Só corta se há palavras extras OU sobra mais de 0.4s de vídeo
    if (extraWordsAfter <= 0 && trailingCut < 0.4) {
      console.log(`[assembler.trimToScript] no extras (${extraWordsAfter}) and little trailing (${trailingCut.toFixed(2)}s), skipping`);
      return false;
    }

    // SAFETY: nunca corta mais que 50% do vídeo. Se cutAt < 50% da duração,
    // o match provavelmente é falso positivo (Whisper transcreveu errado ou
    // achou a última palavra do script cedo demais no transcript).
    if (cutAt < duration * 0.5) {
      console.log(`[assembler.trimToScript] SAFETY: cutAt ${cutAt.toFixed(2)}s is <50% of ${duration.toFixed(2)}s — likely false positive, skipping`);
      return false;
    }

    // SAFETY: se o cut removeria menos de 0.1s mas há extras detectadas,
    // ainda vale — mas se não tem extras e trailingCut é minúsculo, evita I/O.
    if (extraWordsAfter === 0 && trailingCut < 0.2) {
      return false;
    }

    console.log(`[assembler.trimToScript] Cutting at ${cutAt.toFixed(2)}s (was ${duration.toFixed(2)}s, removing ${trailingCut.toFixed(2)}s + ${extraWordsAfter} extra word(s))`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .setDuration(cutAt)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return true;
  } catch (err) {
    console.error("[assembler] trimToScript error:", err);
    return false;
  }
}

// Self-eval: transcreve o vídeo final e mede quantas palavras do script
// consolidado realmente aparecem na transcrição. Retorna coverage 0..1.
// Matching é normalizado (sem acentos, sem pontuação, case-insensitive).
async function evaluateSpeechCoverage(finalVideoPath: string, expectedScript: string): Promise<SpeechCoverage | null> {
  const trimmed = expectedScript.trim();
  if (trimmed.length === 0) return null;

  const words = await transcribeWordsWithWhisper(finalVideoPath);
  if (!words) return null;

  const expectedTokens = trimmed.split(/\s+/).map(normalizeWord).filter((w) => w.length > 0);
  const transcribedSet = new Set(words.map((w) => normalizeWord(w.word)).filter((w) => w.length > 0));

  if (expectedTokens.length === 0) return null;

  let foundCount = 0;
  const missing: string[] = [];
  for (const w of expectedTokens) {
    if (transcribedSet.has(w)) {
      foundCount++;
    } else {
      missing.push(w);
    }
  }

  return {
    expectedWords: expectedTokens.length,
    foundWords: foundCount,
    coverage: foundCount / expectedTokens.length,
    missingWords: missing.slice(0, 30),
  };
}

// Main assembly function
export async function assembleTakes(
  takes: TakeInfo[],
  audioUrl: string | null,
  videoId: string,
  expectedScript?: string | null
): Promise<AssemblyResult> {
  const id = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `ugc-assembly-${id}`);
  await mkdir(tmpDir, { recursive: true });

  const takePaths: string[] = [];
  const concatPath = join(tmpDir, "concat.mp4");
  const finalPath = join(tmpDir, "final.mp4");
  const audioPath = join(tmpDir, "narration.mp3");

  try {
    // Download all takes
    for (let i = 0; i < takes.length; i++) {
      const takePath = join(tmpDir, `take-${i}.mp4`);
      await downloadFile(takes[i].url, takePath);

      // Passo 1: se temos o script pretendido, corta palavras extras alucinadas
      // pelo Veo depois do último word do script (via Whisper word timestamps)
      let currentPath = takePath;
      const intended = takes[i].intendedScript?.trim();
      if (intended && intended.length > 0) {
        const scriptCutPath = join(tmpDir, `take-${i}-scriptcut.mp4`);
        const wasScriptCut = await trimToScript(currentPath, scriptCutPath, intended);
        if (wasScriptCut) {
          await unlink(currentPath).catch(() => {});
          currentPath = scriptCutPath;
        }
      }

      // Passo 2: trim trailing silence — remove qualquer silêncio residual
      const trimmedPath = join(tmpDir, `take-${i}-trimmed.mp4`);
      const wasTrimmed = await trimTrailingSilence(currentPath, trimmedPath);
      if (wasTrimmed) {
        await unlink(currentPath).catch(() => {});
        takePaths.push(trimmedPath);
      } else {
        takePaths.push(currentPath);
      }
    }

    // Concatenate takes
    await concatVideos(takePaths, concatPath);

    // Mix with audio if available
    if (audioUrl) {
      await downloadFile(audioUrl, audioPath);
      await mixAudio(concatPath, audioPath, finalPath);
    } else {
      // Just use the concatenated video
      await writeFile(finalPath, await readFile(concatPath));
    }

    const durationSeconds = await getVideoDuration(finalPath);

    // Self-eval: mede quantas palavras do script aparecem na transcrição do
    // vídeo final. Low coverage = usuário deve saber antes de publicar.
    let coverage: SpeechCoverage | null = null;
    if (expectedScript && expectedScript.trim().length > 0) {
      try {
        coverage = await evaluateSpeechCoverage(finalPath, expectedScript);
        if (coverage) {
          console.log(`[assembler] speech coverage: ${(coverage.coverage * 100).toFixed(1)}% (${coverage.foundWords}/${coverage.expectedWords})${coverage.missingWords.length ? ` missing: ${coverage.missingWords.slice(0, 5).join(",")}` : ""}`);
        }
      } catch (err) {
        console.error("[assembler] evaluateSpeechCoverage failed:", err);
      }
    }

    const videoBuffer = await readFile(finalPath);

    const blob = await put(`ugc-final-${videoId}.mp4`, videoBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return {
      finalVideoUrl: blob.url,
      durationSeconds,
      coverage,
    };
  } finally {
    // Cleanup temp files
    const allPaths = [...takePaths, concatPath, finalPath, audioPath];
    await Promise.all(allPaths.map((p) => unlink(p).catch(() => {})));
    await import("fs/promises").then((fs) => fs.rmdir(tmpDir).catch(() => {}));
  }
}
