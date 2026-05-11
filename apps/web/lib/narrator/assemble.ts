// Narrator assembly: concatena os N takes do Veo (já com áudio removido), corta
// pra duração exata da narração e troca a faixa de áudio pelo MP3 do TTS.
//
// Importante: cada take Veo tem 8s; depois de N takes, vídeo total = N*8s.
// A narração TTS pode ter qualquer duração ≤ N*7.5s (deixamos buffer no plan),
// então cortamos o vídeo final exatamente na duração do TTS.

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpegStaticPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink, mkdir, rmdir } from "fs/promises";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { put } from "@vercel/blob";
import { execFile } from "child_process";
import { promisify } from "util";
import { generateCaptionsAss, type DrawtextChunk } from "./captions";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const execFileP = promisify(execFile);

// Binário moderno de ffmpeg (versão 6.0) — necessário pro filtro `xfade` que
// não existe no @ffmpeg-installer (binário de 2018, ffmpeg N-92722). Usado
// só pelo concatTakes; resto da pipeline continua no fluent-ffmpeg padrão.
const FFMPEG_MODERN_PATH = (ffmpegStaticPath ?? ffmpegInstaller.path) as string;

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Força cada take pra 1080x1920 (9:16 vertical exato). Veo às vezes retorna
// vídeos com aspect ratio interno ligeiramente diferente ou com letterbox/
// pillarbox dentro do frame, o que aparece como "vídeo cortado" pro user.
// scale=1080:1920:force_original_aspect_ratio=increase faz upscale mantendo
// proporção até cobrir toda a área, e crop=1080:1920 corta o excedente
// centralizado. Resultado: NUNCA tem barras pretas, sempre vertical full-frame.
const FORCE_VERTICAL_FILTER = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";

// Concat com re-encode (necessário porque os takes podem vir do Veo com
// timestamps/parâmetros levemente diferentes — concat demuxer falharia).
// Cada take passa pelo FORCE_VERTICAL_FILTER antes do concat pra garantir
// que TODOS estão em 1080x1920 puro.
//
// includeAudio=true preserva o áudio dos takes (usado no modo Veo nativo onde
// o lip-sync vem direto do Veo). includeAudio=false descarta áudio (modo
// B-roll/TTS overlay — áudio é a narração que será muxada depois).
// Duração de cada take Veo 3 Fast (sempre 8s).
const TAKE_DURATION_SECS = 8;
// Mínimo aceitável após trim de silêncio (se a "fala" for muito curta, é
// provável que o silencedetect tenha pego falso positivo — mantém take inteiro).
const MIN_TAKE_AFTER_TRIM = 2.0;
// Margem após o fim da fala detectada — evita cortar a última sílaba mas
// mantém o gap mínimo pra próximo take começar limpo.
const SPEECH_END_PADDING = 0.15;

// Detecta onde o silêncio "longo" começa no fim do áudio. Retorna o timestamp
// (segundos) onde devemos truncar o take. Se não houver silêncio longo, devolve
// a duração inteira do take (8s).
async function detectSpeechEnd(audioPath: string): Promise<number> {
  try {
    const { stderr } = await execFileP(
      FFMPEG_MODERN_PATH,
      ["-hide_banner", "-nostdin", "-i", audioPath, "-af", "silencedetect=n=-35dB:d=0.4", "-f", "null", "-"],
      { maxBuffer: 10 * 1024 * 1024, timeout: 15_000 },
    );
    const matches = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)];
    if (matches.length === 0) return TAKE_DURATION_SECS;
    const lastSilenceStart = parseFloat(matches[matches.length - 1][1]);
    const trimAt = Math.min(TAKE_DURATION_SECS, lastSilenceStart + SPEECH_END_PADDING);
    if (trimAt < MIN_TAKE_AFTER_TRIM) return TAKE_DURATION_SECS;
    return trimAt;
  } catch (err) {
    console.warn("[narrator/assemble] detectSpeechEnd failed, using full duration:", err instanceof Error ? err.message : err);
    return TAKE_DURATION_SECS;
  }
}

// Calcula a duração ideal pra trim do take em modo broll com TTS override:
// usa a duração do MP3 do TTS + padding pequeno. Garante que o take dura
// EXATAMENTE o tempo da fala, sem cauda silenciosa entrando no próximo take.
async function detectOverlayDuration(overlayPath: string): Promise<number> {
  try {
    const d = await ffmpegProbeDuration(overlayPath);
    if (!Number.isFinite(d) || d <= 0) return TAKE_DURATION_SECS;
    const padded = Math.min(TAKE_DURATION_SECS, d + SPEECH_END_PADDING);
    if (padded < MIN_TAKE_AFTER_TRIM) return TAKE_DURATION_SECS;
    return padded;
  } catch {
    return TAKE_DURATION_SECS;
  }
}
// Duração do crossfade entre takes — suaviza snap visual sem comprometer fala.
// 0.25s é curto o suficiente pra ficar imperceptível no áudio quando a quebra
// é em fronteira de pontuação (split por sentence).
const CROSSFADE_SECS = 0.25;
// Filtro de normalização aplicado a cada take ANTES do xfade. fps e
// setpts=PTS-STARTPTS são obrigatórios pra xfade não dar "Invalid argument" —
// streams precisam ter timebase e fps idênticos.
// Filtros aplicados no PRE-PROCESS de cada take (1 input ffmpeg por take, leve).
// O pre-process produz arquivos /tmp/norm_i.mp4 já normalizados, trimmed e com
// áudio limpo. O filter complex final então só precisa fazer xfade entre eles.
const PREPROCESS_VIDEO_FILTER = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30";
// Áudio: cadeia agressiva pra eliminar música/SFX de fundo e manter só a voz.
// - highpass=100Hz: corta bass (a maior parte da música tá lá)
// - afftdn nr=12: denoiser FFT — remove ruído tonal estável (música/ambient)
// - lowpass=7500Hz: corta agudos onde residem efeitos sonoros estilizados
// - dynaudnorm: padroniza volume entre takes
const PREPROCESS_AUDIO_FILTER = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,highpass=f=100,afftdn=nr=12:nt=w,lowpass=f=7500,dynaudnorm=f=200:g=15";

// Concat ou crossfade os takes em sequência. Quando N > 1, usa xfade visual
// pra eliminar "snap" entre takes (cada take parte da mesma foto, então sem
// crossfade haveria um corte seco onde o avatar volta pra pose inicial).
//
// includeAudio=true preserva o áudio dos takes (modo Veo nativo) e aplica
// acrossfade pareado pra manter sync com xfade visual. includeAudio=false
// descarta áudio (B-roll / TTS overlay — áudio é narração muxada depois).
// Pré-processa um take: aplica normalize de vídeo + áudio + trim na duração
// detectada + (opcional) fade-in no início e fade-out no fim. Output: MP4
// pronto pra concat demuxer (mesmos codecs/fps/sar).
//
// fadeIn/fadeOut: quando true, aplica fade visual e de áudio nos extremos —
// usado pra suavizar transição entre takes no concat demuxer (sem xfade
// complex pesado).
//
// audioOverridePath: substitui áudio do take pelo MP3 fornecido (usado em
// mixed mode pros takes broll receberem TTS daquele trecho).
async function preprocessTake(
  inputPath: string,
  outputPath: string,
  duration: number,
  includeAudio: boolean,
  audioOverridePath: string | null = null,
  fadeIn = false,
  fadeOut = false,
): Promise<void> {
  // Fade visual curto pra esconder "snap" de pose entre takes. Áudio NÃO leva
  // fade — o trim já corta o áudio exatamente no fim da fala (com 0.15s de
  // padding), então sobrepor um afade aqui faria a última palavra somar com
  // a primeira do próximo take. Áudio termina seco e o vídeo dá o fade visual.
  const fadeDur = 0.15;
  let vFilter = PREPROCESS_VIDEO_FILTER;
  if (fadeIn) vFilter += `,fade=t=in:st=0:d=${fadeDur}`;
  if (fadeOut) vFilter += `,fade=t=out:st=${(duration - fadeDur).toFixed(3)}:d=${fadeDur}`;

  // Áudio: SEM fade (só normalize). O trim no -t global corta antes.
  const aFilter = PREPROCESS_AUDIO_FILTER;

  const args = ["-y", "-hide_banner", "-i", inputPath];
  if (audioOverridePath) args.push("-i", audioOverridePath);
  args.push("-t", duration.toFixed(3));
  args.push("-vf", vFilter);
  if (audioOverridePath) {
    args.push("-map", "0:v", "-map", "1:a");
    args.push("-af", aFilter);
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
  } else if (includeAudio) {
    args.push("-af", aFilter);
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
  } else {
    args.push("-an");
  }
  // Codec/params idênticos em todos os takes pra concat demuxer aceitar.
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.0",
    "-r", "30",
    "-movflags", "+faststart",
    outputPath,
  );
  await execFileP(FFMPEG_MODERN_PATH, args, { maxBuffer: 100 * 1024 * 1024, timeout: 60_000 });
}

// Limite de concorrência para ffmpegs simultâneos. Vercel Lambda 1024MB/1vCPU
// não aguenta nem 2 ffmpegs paralelos com filter pesado — fica sequencial.
const FFMPEG_CONCURRENCY = 1;

// Executa fn(item, idx) em chunks de `limit` por vez. Preserva ordem do array
// resultante e propaga o primeiro erro.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function concatTakes(inputPaths: string[], outputPath: string, includeAudio: boolean, audioOverridePaths: (string | null)[] = []): Promise<void> {
  // Detecta a duração que cada take deve ter:
  //  - Sem áudio (B-roll legacy / TTS overlay global): usa duração total fixa.
  //  - Com audio override (broll em mixed): duração do MP3 do TTS daquele
  //    segmento (vídeo do Veo é mudo de 8s, irrelevante; o que conta é o
  //    áudio final que vai entrar).
  //  - Com áudio Veo (avatar/cutout): detecta fim da fala via silencedetect.
  const trimDurations = !includeAudio
    ? inputPaths.map(() => TAKE_DURATION_SECS)
    : await mapWithConcurrency(inputPaths, FFMPEG_CONCURRENCY, (videoPath, i) => {
        const overlay = audioOverridePaths[i];
        return overlay ? detectOverlayDuration(overlay) : detectSpeechEnd(videoPath);
      });
  console.log(`[narrator/assemble] take durations:`, trimDurations.map((d) => d.toFixed(2)));

  const tmpDir = dirname(outputPath);
  const runId = randomBytes(4).toString("hex");

  // 1. Pre-process cada take SEQUENCIALMENTE com fade-in/out aplicado nos
  // extremos (exceto primeiro/último). Codec/params idênticos pra concat
  // demuxer aceitar. fade-out + fade-in nas bordas dá uma transição
  // fade-to-black de ~0.5s que substitui o xfade complex.
  const n = inputPaths.length;
  const normalizedPaths: string[] = new Array(inputPaths.length);
  await mapWithConcurrency(inputPaths, FFMPEG_CONCURRENCY, async (input, i) => {
    const out = join(tmpDir, `narrator-norm-${runId}-${i}.mp4`);
    const audioOverride = audioOverridePaths[i] ?? null;
    const fadeIn = i > 0;          // não fade-in no primeiro take
    const fadeOut = i < n - 1;     // não fade-out no último take
    console.log(`[narrator/assemble] preprocess take ${i} (dur=${trimDurations[i].toFixed(2)}s)${audioOverride ? " [audio override]" : ""}${fadeIn ? " fadeIn" : ""}${fadeOut ? " fadeOut" : ""}`);
    await preprocessTake(input, out, trimDurations[i], includeAudio, audioOverride, fadeIn, fadeOut);
    normalizedPaths[i] = out;
  });

  try {
    if (normalizedPaths.length === 1) {
      // 1 take só — renomeia o pre-processed pro outputPath.
      const { rename } = await import("fs/promises");
      await rename(normalizedPaths[0], outputPath);
      normalizedPaths[0] = "";
      return;
    }

    // 2. Concat via demuxer com stream copy. Como os takes têm codec/fps/sar
    // idênticos (forçados no pre-process), o demuxer aceita sem re-encode.
    // Operação é IO-bound (segundos), não CPU-bound. Resolve o travamento do
    // filter complex pesado em Vercel Lambda.
    const concatList = join(tmpDir, `concat-${runId}.txt`);
    const listContent = normalizedPaths
      .map((p) => `file '${p.replace(/\\/g, "/")}'`)
      .join("\n");
    const { writeFile: writeFilePromise } = await import("fs/promises");
    await writeFilePromise(concatList, listContent);

    const args = [
      "-y", "-hide_banner",
      "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ];
    console.log(`[narrator/assemble] concat demuxer (${n} takes)`);
    try {
      const { stderr } = await execFileP(FFMPEG_MODERN_PATH, args, {
        maxBuffer: 100 * 1024 * 1024,
        timeout: 60_000,
      });
      const tail = stderr.split("\n").slice(-5).join("\n");
      console.log("[narrator/assemble] concat done. tail:\n", tail);
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      console.error("[narrator/assemble] concat FAILED:", e.message);
      console.error("[narrator/assemble] concat stderr:", e.stderr?.slice(-3000));
      throw err;
    } finally {
      await unlink(concatList).catch(() => {});
    }
  } finally {
    for (const p of normalizedPaths) {
      if (p) await unlink(p).catch(() => {});
    }
  }
}

// Acha a fonte Anton.ttf que embarcamos em lib/narrator/fonts/. Em prod,
// cwd = /var/task/apps/web e a fonte é incluída via outputFileTracingIncludes.
async function findUsableFont(): Promise<string | null> {
  const { access } = await import("fs/promises");
  const candidates = [
    join(process.cwd(), "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    join(process.cwd(), "apps", "web", "lib", "narrator", "fonts", "Anton-Regular.ttf"),
    "/var/task/apps/web/lib/narrator/fonts/Anton-Regular.ttf",
    "/var/task/lib/narrator/fonts/Anton-Regular.ttf",
    join(process.cwd(), "public", "fonts", "Anton-Regular.ttf"),
    join(process.cwd(), "apps", "web", "public", "fonts", "Anton-Regular.ttf"),
    // fallbacks improváveis em Lambda
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  for (const p of candidates) {
    try {
      await access(p);
      console.log(`[narrator/assemble] using font: ${p}`);
      return p;
    } catch { /* ignora */ }
  }
  console.warn("[narrator/assemble] no font found in any candidate path");
  return null;
}

// Checa se o ffmpeg do installer tem o filtro `subtitles` (libass) disponível.
// Cacheia resultado pra não rodar a cada call.
let subtitlesSupportCache: boolean | null = null;
async function checkSubtitlesSupport(): Promise<boolean> {
  if (subtitlesSupportCache !== null) return subtitlesSupportCache;
  try {
    const { stdout } = await execFileP(ffmpegInstaller.path, ["-hide_banner", "-filters"], {
      maxBuffer: 5 * 1024 * 1024,
    });
    const has = /\bsubtitles\b/i.test(stdout);
    console.log(`[narrator/assemble] subtitles filter support: ${has}`);
    subtitlesSupportCache = has;
    return has;
  } catch (err) {
    console.error("[narrator/assemble] checkSubtitlesSupport error:", err);
    subtitlesSupportCache = false;
    return false;
  }
}

// Mux narração + vídeo + (opcional) burn legendas via libass (subtitles=).
// Roda execFile direto pra capturar stderr quando der erro.
async function muxWithSubtitles(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, assPath: string, fontsDir: string | null): Promise<void> {
  // Path POSIX: no Linux do Vercel não há `:`; só normalizamos backslashes.
  const safeAssPath = assPath.replace(/\\/g, "/");
  const subtitlesFilter = fontsDir
    ? `subtitles=${safeAssPath}:fontsdir=${fontsDir.replace(/\\/g, "/")}`
    : `subtitles=${safeAssPath}`;
  const args = [
    "-y",
    "-hide_banner",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", subtitlesFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", narrationSeconds.toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ];
  console.log("[narrator/assemble] running ffmpeg with subtitles filter, ass:", safeAssPath);
  try {
    const { stderr } = await execFileP(ffmpegInstaller.path, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 240_000,
    });
    // ffmpeg sempre escreve no stderr — só é erro se exit != 0 (lança throw)
    const tail = stderr.split("\n").slice(-6).join("\n");
    console.log("[narrator/assemble] ffmpeg subtitles done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[narrator/assemble] ffmpeg subtitles FAILED:", e.message);
    console.error("[narrator/assemble] ffmpeg stderr:", e.stderr?.slice(-3000));
    throw err;
  }
}

// Mux com drawtext (fallback se libass não disponível). Cada chunk vira um
// drawtext com `enable='between(t,start,end)'` e leve fade via alpha expr.
async function muxWithDrawtext(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string, chunks: DrawtextChunk[], fontPath: string | null): Promise<void> {
  // Constrói filter graph com N drawtext encadeados
  const filters = chunks.map((c, i) => {
    const safeText = c.text
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "’")  // troca apóstrofo por aspa unicode pra evitar bagunça
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .toUpperCase();
    const startMs = (c.start * 1000).toFixed(0);
    const endMs = (c.end * 1000).toFixed(0);
    const popDur = Math.min(180, Math.max(80, (c.end - c.start) * 1000 * 0.3));
    // alpha: fade in nos primeiros 100ms, fade out nos últimos 80ms
    const alphaExpr = `if(lt(t,${c.start}),0,if(lt(t,${c.start}+0.1),(t-${c.start})/0.1,if(gt(t,${c.end}-0.08),max(0,(${c.end}-t)/0.08),1)))`;
    // fontsize varia: cresce 18% nos primeiros popDur ms e estabiliza
    const baseSize = i % 4 === 1 ? 130 : 120;
    const colorByIdx = ["white", "0xFFD700", "white", "0xFFC857"];
    const color = colorByIdx[i % colorByIdx.length];
    const fontfileArg = fontPath ? `:fontfile='${fontPath.replace(/\\/g, "/")}'` : "";
    return `drawtext=text='${safeText}'${fontfileArg}:fontsize=${baseSize}:fontcolor=${color}:bordercolor=black:borderw=8:shadowcolor=black@0.7:shadowx=2:shadowy=4:x=(w-text_w)/2:y=h*0.66:alpha='${alphaExpr}':enable='between(t,${c.start},${c.end})'`;
  }).join(",");

  const args = [
    "-y",
    "-hide_banner",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-vf", filters,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-t", narrationSeconds.toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ];

  console.log(`[narrator/assemble] running ffmpeg with drawtext (${chunks.length} chunks, font=${fontPath ?? "default"})`);
  try {
    const { stderr } = await execFileP(ffmpegInstaller.path, args, {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 240_000,
    });
    const tail = stderr.split("\n").slice(-6).join("\n");
    console.log("[narrator/assemble] drawtext done. tail:\n", tail);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    console.error("[narrator/assemble] drawtext FAILED:", e.message);
    console.error("[narrator/assemble] drawtext stderr:", e.stderr?.slice(-3000));
    throw err;
  }
}

// Mux sem legendas (fallback final): copia vídeo, troca áudio.
async function muxNoCaptions(videoPath: string, audioPath: string, narrationSeconds: number, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", narrationSeconds.toFixed(3),
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}

export interface AssembleNarratorArgs {
  takeUrls: string[];                   // URLs dos N takes Veo (ordem)
  narrationAudioUrl: string | null;     // URL do MP3 do TTS global (null no modo Veo nativo)
  narrationSeconds: number;             // duração estimada/real da narração
  jobId: string;                        // pra nomear o blob
  audioMode: "veo_native" | "tts_overlay";
  // Modo misturado: por take, opcional URL de MP3 que SUBSTITUI o áudio
  // daquele take. Usado pros segments style='broll' em mixed mode (avatar/cutout
  // mantém áudio Veo). null/undefined em índices que mantêm áudio original.
  audioOverlays?: (string | null)[];
}

export interface AssembleNarratorResult {
  finalVideoUrl: string;
  durationSeconds: number;
}

export async function assembleNarratorVideo(args: AssembleNarratorArgs): Promise<AssembleNarratorResult> {
  const id = randomBytes(8).toString("hex");
  const tmpDir = join("/tmp", `narrator-${id}`);
  await mkdir(tmpDir, { recursive: true });

  const takePaths: string[] = [];
  const concatPath = join(tmpDir, "concat.mp4");
  const audioPath  = join(tmpDir, "narration.mp3");
  const assPath    = join(tmpDir, "captions.ass");
  const finalPath  = join(tmpDir, "final.mp4");

  // Audio overlays paths (depois do download). Mesmo tamanho que takeUrls,
  // entrada null pra takes que mantêm áudio original.
  const audioOverlayPaths: (string | null)[] = new Array(args.takeUrls.length).fill(null);

  try {
    // Download takes em paralelo
    await Promise.all(
      args.takeUrls.map(async (url, i) => {
        const p = join(tmpDir, `take-${i}.mp4`);
        await downloadToFile(url, p);
        takePaths[i] = p;
      })
    );

    // Download audio overlays (se houver) em paralelo
    if (args.audioOverlays && args.audioOverlays.length > 0) {
      await Promise.all(
        args.audioOverlays.map(async (url, i) => {
          if (!url) return;
          const p = join(tmpDir, `overlay-${i}.mp3`);
          await downloadToFile(url, p);
          audioOverlayPaths[i] = p;
        }),
      );
    }

    // ───────── Modo Veo nativo ─────────
    // Áudio (fala + lip-sync) vem direto dos takes. Concat preservando áudio,
    // sem TTS overlay global, sem captions. Em modo mixed, alguns takes têm
    // audioOverlay (TTS específico daquele segment broll) que substitui o áudio
    // mudo do Veo.
    if (args.audioMode === "veo_native") {
      await concatTakes(takePaths, finalPath, true, audioOverlayPaths);
      const buffer = await readFile(finalPath);
      const blob = await put(`narrator-${args.jobId}.mp4`, buffer, {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      const actualDuration = await ffmpegProbeDuration(finalPath);
      return {
        finalVideoUrl: blob.url,
        durationSeconds: actualDuration > 0 ? actualDuration : takePaths.length * 8,
      };
    }

    // ───────── Modo TTS overlay (B-roll OU avatar mudo) ─────────
    if (!args.narrationAudioUrl) {
      throw new Error("narrationAudioUrl é obrigatório no modo tts_overlay");
    }
    await downloadToFile(args.narrationAudioUrl, audioPath);

    // Concatena vídeos (sem áudio — takes já vêm sem áudio do strip)
    await concatTakes(takePaths, concatPath, false);

    // Gera ASS + chunks (whisper). Se Whisper falhar, segue sem legenda.
    const captionsResult = await generateCaptionsAss(audioPath, args.narrationSeconds, assPath);
    console.log(`[narrator/assemble] captions: words=${captionsResult.wordsCount} chunks=${captionsResult.chunks.length} assOk=${captionsResult.assWritten}`);

    const fontPath = await findUsableFont();
    const fontsDir = fontPath ? fontPath.substring(0, fontPath.lastIndexOf("/")) || fontPath.substring(0, fontPath.lastIndexOf("\\")) : null;

    let captionsBurned = false;
    if (captionsResult.assWritten) {
      // Tenta primeiro libass (mais bonito)
      const hasSubtitles = await checkSubtitlesSupport();
      if (hasSubtitles) {
        try {
          await muxWithSubtitles(concatPath, audioPath, args.narrationSeconds, finalPath, assPath, fontsDir);
          captionsBurned = true;
        } catch (err) {
          console.error("[narrator/assemble] subtitles failed, will try drawtext:", err);
        }
      }
    }

    // Fallback: drawtext (sem libass)
    if (!captionsBurned && captionsResult.chunks.length > 0) {
      try {
        await muxWithDrawtext(concatPath, audioPath, args.narrationSeconds, finalPath, captionsResult.chunks, fontPath);
        captionsBurned = true;
      } catch (err) {
        console.error("[narrator/assemble] drawtext failed too, will mux without captions:", err);
      }
    }

    // Fallback final: sem legenda
    if (!captionsBurned) {
      console.warn("[narrator/assemble] burning no captions");
      await muxNoCaptions(concatPath, audioPath, args.narrationSeconds, finalPath);
    }

    const buffer = await readFile(finalPath);
    const blob = await put(`narrator-${args.jobId}.mp4`, buffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return { finalVideoUrl: blob.url, durationSeconds: args.narrationSeconds };
  } finally {
    const overlays = audioOverlayPaths.filter((p): p is string => Boolean(p));
    const all = [...takePaths, ...overlays, concatPath, audioPath, assPath, finalPath];
    await Promise.all(all.map((p) => unlink(p).catch(() => {})));
    await rmdir(tmpDir).catch(() => {});
  }
}

// Pega duração de um arquivo de áudio/vídeo via ffmpeg (parse stderr)
export function ffmpegProbeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let stderr = "";
    ffmpeg(filePath)
      .outputOptions(["-f", "null"])
      .output(process.platform === "win32" ? "NUL" : "/dev/null")
      .on("stderr", (line: string) => { stderr += line + "\n"; })
      .on("end", () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (m) {
          resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100);
        } else {
          resolve(0);
        }
      })
      .on("error", () => resolve(0))
      .run();
  });
}
