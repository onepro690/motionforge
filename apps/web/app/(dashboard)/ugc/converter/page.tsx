"use client";

// Conversor de vídeo client-side via ffmpeg.wasm.
// Zero upload pro servidor: o arquivo entra no wasm do browser, é
// transcodificado com libx264+aac, e o .mp4 resultante é salvo direto
// no disco do usuário.
//
// Estratégia:
//  - INPUT: montado via WORKERFS — ffmpeg lê o File direto do disco do
//    navegador SEM copiar pra memória do wasm. Inputs de múltiplos GB
//    funcionam.
//  - OUTPUT: escrito no MEMFS do wasm (preciso ter o arquivo inteiro
//    antes de expor como Blob). O teto prático é ~1.5GB de output por
//    limite de heap do wasm32. Se o user pedir alta qualidade em
//    vídeos muito longos, o exec pode estourar — nesse caso sugerimos
//    trocar pro preset "Rápido" (CRF maior = arquivo menor).
//
// Os cores do ffmpeg (~30MB) são copiados pra /public/ffmpeg/ no build
// (ver apps/web/package.json:scripts.build).

import { useCallback, useRef, useState } from "react";
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { FileVideo, Loader2, Download, AlertTriangle, Check } from "lucide-react";

type Status =
  | "idle"
  | "loading_ffmpeg"
  | "reading_file"
  | "converting"
  | "writing_output"
  | "done"
  | "error";

const PRESETS = [
  {
    id: "remux",
    label: "⚡ Remux rápido (sem re-encodar · poucos segundos)",
    args: [
      "-c", "copy",
      "-movflags", "+faststart",
    ],
  },
  {
    id: "balanced",
    label: "Balanceado (H.264 CRF 23 · AAC 192k · demora bastante)",
    args: [
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
    ],
  },
  {
    id: "high",
    label: "Alta qualidade (H.264 CRF 18 · AAC 256k · demora MUITO)",
    args: [
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "256k",
      "-movflags", "+faststart",
    ],
  },
  {
    id: "fast",
    label: "Rápido (H.264 CRF 28 · AAC 128k · demora menos)",
    args: [
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
    ],
  },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ConverterPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [output, setOutput] = useState<{ url: string; name: string; size: number } | null>(null);
  const [preset, setPreset] = useState<PresetId>("remux");
  const [logTail, setLogTail] = useState<string>("");
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureFFmpeg = useCallback(async (): Promise<FFmpeg> => {
    if (ffmpegRef.current) return ffmpegRef.current;
    setStatus("loading_ffmpeg");
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => {
      setLogTail(message);
    });
    ff.on("progress", ({ progress: p }) => {
      if (Number.isFinite(p) && p >= 0 && p <= 1) {
        setProgress(Math.round(p * 100));
      }
    });
    await ff.load({
      coreURL: "/ffmpeg/ffmpeg-core.js",
      wasmURL: "/ffmpeg/ffmpeg-core.wasm",
    });
    ffmpegRef.current = ff;
    return ff;
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (output) {
        URL.revokeObjectURL(output.url);
        setOutput(null);
      }
      setError(null);
      setProgress(0);
      setFileInfo({ name: file.name, size: file.size });

      // Aviso soft: arquivos muito grandes podem estourar o heap do
      // wasm32 (cap 4GB, output prático ~1.5GB). Deixamos passar — se
      // estourar durante o exec, o erro é claro pro user tentar um
      // preset menor.
      if (file.size > 4 * 1024 * 1024 * 1024) {
        setError(
          `Arquivo maior que 4GB (${formatBytes(file.size)}). O wasm32 do ffmpeg não consegue alocar o output nesse tamanho. Use ffmpeg no desktop.`,
        );
        setStatus("error");
        return;
      }

      const startedAt = Date.now();
      setElapsed(0);
      if (elapsedTimer.current) clearInterval(elapsedTimer.current);
      elapsedTimer.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 500);

      const MOUNT_POINT = "/mnt";
      const outputName = "output.mp4";
      let mounted = false;
      try {
        const ff = await ensureFFmpeg();

        setStatus("reading_file");
        // Cria o ponto de montagem (idempotente — ignora se já existe).
        try {
          await ff.createDir(MOUNT_POINT);
        } catch {
          /* ignore: pasta já pode existir */
        }
        // Monta o File direto do disco via WORKERFS. Zero cópia pra
        // memória do wasm — o ffmpeg faz reads sob demanda.
        await ff.mount(FFFSType.WORKERFS, { files: [file] }, MOUNT_POINT);
        mounted = true;
        const inputPath = `${MOUNT_POINT}/${file.name}`;

        setStatus("converting");
        const presetDef =
          PRESETS.find((p) => p.id === preset) ?? PRESETS[0];
        const code = await ff.exec([
          "-i", inputPath,
          ...presetDef.args,
          outputName,
        ]);
        if (code !== 0) {
          throw new Error(`ffmpeg retornou código ${code}. Veja o log abaixo.`);
        }

        setStatus("writing_output");
        const data = await ff.readFile(outputName);
        const bytes =
          data instanceof Uint8Array
            ? new Uint8Array(data)
            : new TextEncoder().encode(String(data));
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: "video/mp4",
        });
        const url = URL.createObjectURL(blob);
        const outName = file.name.replace(/\.[^.]+$/, "") + ".mp4";
        setOutput({ url, name: outName, size: blob.size });
        setStatus("done");

        try {
          await ff.deleteFile(outputName);
        } catch {
          /* ignore */
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "conversão falhou";
        setError(msg);
        setStatus("error");
      } finally {
        if (mounted && ffmpegRef.current) {
          try {
            await ffmpegRef.current.unmount(MOUNT_POINT);
          } catch {
            /* ignore */
          }
        }
        if (elapsedTimer.current) {
          clearInterval(elapsedTimer.current);
          elapsedTimer.current = null;
        }
      }
    },
    [ensureFFmpeg, output, preset],
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const reset = () => {
    if (output) URL.revokeObjectURL(output.url);
    setOutput(null);
    setFileInfo(null);
    setError(null);
    setProgress(0);
    setStatus("idle");
    setLogTail("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const busy =
    status === "loading_ffmpeg" ||
    status === "reading_file" ||
    status === "converting" ||
    status === "writing_output";

  const statusLabel =
    status === "loading_ffmpeg"
      ? "Carregando ffmpeg..."
      : status === "reading_file"
        ? "Lendo arquivo..."
        : status === "converting"
          ? "Convertendo..."
          : status === "writing_output"
            ? "Gerando MP4..."
            : status === "done"
              ? "Pronto"
              : status === "error"
                ? "Erro"
                : "Aguardando arquivo";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <FileVideo className="h-6 w-6 text-violet-400" />
          Conversor de Vídeo
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Converte arquivos de vídeo (.webm, .mov, .mkv, etc) para MP4
          (H.264+AAC). Tudo roda no seu navegador — o arquivo não sai do
          seu computador.
        </p>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
        <label className="block text-sm font-medium text-neutral-200">
          Preset
        </label>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as PresetId)}
          disabled={busy}
          className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none disabled:opacity-50"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {preset === "remux" ? (
          <p className="mt-2 text-xs text-violet-300">
            ⚡ Só troca o container .webm → .mp4 sem re-encodar. Termina em
            segundos mesmo pra arquivos de GBs. Funciona em CapCut,
            TikTok, Premiere, DaVinci. <strong>Não funciona</strong> em
            reproduzir direto no iOS/Safari (VP9 não é suportado lá).
          </p>
        ) : (
          <p className="mt-2 text-xs text-yellow-500">
            ⚠️ Re-encodar em H.264 no ffmpeg.wasm é lento: pode levar
            várias horas pra 1h de vídeo. Se seu editor aceita VP9 em
            MP4 (CapCut, TikTok, Premiere, DaVinci aceitam),
            use <strong>Remux rápido</strong>.
          </p>
        )}

        <div className="mt-5">
          <label className="block text-sm font-medium text-neutral-200">
            Arquivo de vídeo
          </label>
          <input
            ref={inputRef}
            type="file"
            accept="video/*,.webm,.mkv,.mov,.mp4,.avi,.flv"
            disabled={busy}
            onChange={onInputChange}
            className="mt-2 block w-full text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-violet-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-violet-500 disabled:opacity-50"
          />
          <p className="mt-2 text-xs text-neutral-500">
            Input é lido direto do disco (suporta GBs). O MP4 final
            precisa caber na memória do wasm (~1.5GB prático) — se
            estourar em arquivos muito longos, use o preset{" "}
            <strong>Rápido</strong> pra gerar um arquivo menor.
          </p>
        </div>
      </div>

      {(fileInfo || busy || status !== "idle") && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">
                {statusLabel}
              </p>
              {fileInfo && (
                <p className="mt-1 truncate text-xs text-neutral-500">
                  {fileInfo.name} · {formatBytes(fileInfo.size)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-400">
              {busy && <Loader2 className="h-4 w-4 animate-spin text-violet-400" />}
              {status === "done" && <Check className="h-5 w-5 text-green-400" />}
              {status === "error" && (
                <AlertTriangle className="h-5 w-5 text-red-400" />
              )}
              {busy && <span>{formatTime(elapsed)}</span>}
            </div>
          </div>

          {(status === "converting" || status === "writing_output") && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-neutral-500">
                <span>{progress}%</span>
                <span>{formatTime(elapsed)}</span>
              </div>
            </div>
          )}

          {logTail && busy && (
            <pre className="mt-3 max-h-20 overflow-hidden truncate rounded bg-black/40 p-2 text-[10px] text-neutral-500">
              {logTail}
            </pre>
          )}

          {error && (
            <div className="mt-3 rounded-md border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {output && status === "done" && (
            <div className="mt-4 flex flex-col gap-3 rounded-md border border-green-900/50 bg-green-950/30 p-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {output.name}
                  </p>
                  <p className="text-xs text-neutral-400">
                    {formatBytes(output.size)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={output.url}
                  download={output.name}
                  className="inline-flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500"
                >
                  <Download className="h-4 w-4" />
                  Baixar MP4
                </a>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
                >
                  Converter outro
                </button>
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="mt-3">
              <button
                type="button"
                onClick={reset}
                className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-white hover:bg-neutral-700"
              >
                Tentar outro arquivo
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
