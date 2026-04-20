"use client";

// Gravação 100% local via File System Access API:
// 1. Usuário clica Gravar → abrimos a live numa nova aba.
// 2. Modal pede "Iniciar Captura" → chamamos:
//    a) showSaveFilePicker — user escolhe onde salvar o .webm
//    b) getDisplayMedia — user escolhe a aba do TikTok (com áudio)
// 3. MediaRecorder timeslice 30s → cada chunk é escrito DIRETO no arquivo
//    local via FileSystemWritableFileStream. Zero memória acumulada, zero
//    upload, suporta gravações de qualquer tamanho.
// 4. Stop → fecha arquivo + marca DONE no DB (só metadata, sem bytes).
//
// Zero dependência de HLS/FLV/status do TikTok. Zero limite de Vercel.
// Requer Chrome/Edge desktop (Firefox/Safari não têm File System Access).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const CHUNK_MS = 30_000;

// Output 9:16 — popup TikTok abre em 540x960; se usuário redimensionar,
// canvas continua 540x960 e a gente center-crop do source.
const OUT_W = 540;
const OUT_H = 960;

// Ambient types — File System Access API ainda não está no lib.dom.d.ts
// estável de todas as versões do TS.
declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{
        description?: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<FileSystemFileHandle>;
  }
  interface FileSystemFileHandle {
    readonly name: string;
    createWritable(options?: {
      keepExistingData?: boolean;
    }): Promise<FileSystemWritableFileStream>;
  }
  interface FileSystemWritableFileStream {
    write(data: Blob | BufferSource | string): Promise<void>;
    close(): Promise<void>;
  }
}

interface ActiveRecording {
  sessionId: string;
  hostHandle: string;
  liveUrl: string;
  status: "awaiting_capture" | "recording" | "finalizing" | "error";
  chunks: number;
  seconds: number;
  startedAt: number;
  error: string | null;
  fileName: string | null;
  writePending: boolean;
}

interface ContextValue {
  startRecording: (
    sessionId: string,
    hostHandle: string,
    onFinish?: () => void,
  ) => void;
  cancelAwaitingCapture: (sessionId: string) => void;
  beginCapture: (sessionId: string) => Promise<void>;
  stopRecording: (sessionId: string) => void;
  isRecording: (sessionId: string) => boolean;
  getState: (sessionId: string) => ActiveRecording | undefined;
  activeIds: string[];
}

const Ctx = createContext<ContextValue | null>(null);

export function useLiveRecording(): ContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useLiveRecording precisa estar dentro de <LiveRecordingProvider>",
    );
  }
  return ctx;
}

interface Runtime {
  recorder: MediaRecorder | null;
  stream: MediaStream | null; // stream COMBINADO (canvas vídeo + aba áudio) — vai pro recorder
  rawStream: MediaStream | null; // getDisplayMedia cru — tracks originais da aba
  canvasStream: MediaStream | null; // captureStream() do canvas
  videoEl: HTMLVideoElement | null;
  cropRaf: number | null;
  writable: FileSystemWritableFileStream | null;
  fileHandle: FileSystemFileHandle | null;
  writeQueue: Promise<void>;
  onFinish?: () => void;
  stopped: boolean;
  secondsWritten: number;
  lastProgressReportedAt: number;
  popupWindow: Window | null;
}

function pickMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

function sanitizeFileName(handle: string): string {
  const clean = handle.replace(/[^\w.-]/g, "_").slice(0, 60) || "live";
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${clean}-${ts}.webm`;
}

async function postMetadata(
  sessionId: string,
  event: "start" | "progress" | "stop" | "cancel",
  extras: { fileName?: string; durationSeconds?: number } = {},
): Promise<void> {
  try {
    await fetch(`/api/ugc/lives/${sessionId}/local-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...extras }),
    });
  } catch {
    /* metadata é best-effort; não impede gravação */
  }
}

export function LiveRecordingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [states, setStates] = useState<Record<string, ActiveRecording>>({});
  const runtimes = useRef<Map<string, Runtime>>(new Map());
  const [, setTick] = useState(0);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureTicker = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setInterval(() => {
      if (runtimes.current.size === 0) {
        if (tickTimer.current) {
          clearInterval(tickTimer.current);
          tickTimer.current = null;
        }
        return;
      }
      setTick((t) => t + 1);
    }, 1000);
  }, []);

  const updateState = useCallback(
    (sessionId: string, patch: Partial<ActiveRecording>) => {
      setStates((s) => {
        const prev = s[sessionId];
        if (!prev) return s;
        return { ...s, [sessionId]: { ...prev, ...patch } };
      });
    },
    [],
  );

  const finalize = useCallback(
    async (sessionId: string) => {
      const rt = runtimes.current.get(sessionId);
      updateState(sessionId, { status: "finalizing" });
      try {
        if (rt) {
          try {
            if (rt.recorder && rt.recorder.state !== "inactive") {
              rt.recorder.stop();
            }
          } catch {
            /* ignore */
          }
          // Dá tempo pro último ondataavailable enfileirar a escrita final.
          await new Promise((r) => setTimeout(r, 500));
          // Espera toda a fila de escrita drenar.
          try {
            await rt.writeQueue;
          } catch {
            /* ignore */
          }
          if (rt.writable) {
            try {
              await rt.writable.close();
            } catch {
              /* ignore */
            }
          }
          // Para a raf de crop antes de parar tracks — evita drawImage
          // num video sem stream.
          if (rt.cropRaf !== null) {
            try {
              cancelAnimationFrame(rt.cropRaf);
            } catch {
              /* noop */
            }
          }
          for (const s of [rt.rawStream, rt.canvasStream]) {
            if (!s) continue;
            for (const track of s.getTracks()) {
              try {
                track.stop();
              } catch {
                /* noop */
              }
            }
          }
          if (rt.videoEl) {
            try {
              rt.videoEl.pause();
              rt.videoEl.srcObject = null;
              rt.videoEl.remove();
            } catch {
              /* noop */
            }
          }
          if (rt.popupWindow && !rt.popupWindow.closed) {
            try {
              rt.popupWindow.close();
            } catch {
              /* cross-origin: ignore */
            }
          }
          await postMetadata(sessionId, "stop", {
            durationSeconds: rt.secondsWritten,
          });
        }
      } finally {
        const onFinish = rt?.onFinish;
        runtimes.current.delete(sessionId);
        setStates((s) => {
          const n = { ...s };
          delete n[sessionId];
          return n;
        });
        if (onFinish) {
          try {
            onFinish();
          } catch {
            /* noop */
          }
        }
      }
    },
    [updateState],
  );

  const startRecording = useCallback(
    (sessionId: string, hostHandle: string, onFinish?: () => void) => {
      if (runtimes.current.has(sessionId)) return;
      const cleanHandle = hostHandle.replace(/^@/, "");
      const liveUrl = `https://www.tiktok.com/@${cleanHandle}/live`;

      // Popup 540x960 (9:16) — força layout mobile do TikTok onde o
      // vídeo ocupa toda a janela (sem coluna de chat do desktop).
      // popup=yes hint faz o Chrome abrir como janela separada (ao invés
      // de tab), facilitando a seleção em getDisplayMedia.
      const features = `popup=yes,width=${OUT_W},height=${OUT_H},noopener,noreferrer`;
      let popupWindow: Window | null = null;
      try {
        popupWindow = window.open(liveUrl, "_blank", features);
      } catch {
        popupWindow = null;
      }

      runtimes.current.set(sessionId, {
        recorder: null,
        stream: null,
        rawStream: null,
        canvasStream: null,
        videoEl: null,
        cropRaf: null,
        writable: null,
        fileHandle: null,
        writeQueue: Promise.resolve(),
        onFinish,
        stopped: false,
        secondsWritten: 0,
        lastProgressReportedAt: 0,
        popupWindow,
      });

      setStates((s) => ({
        ...s,
        [sessionId]: {
          sessionId,
          hostHandle: cleanHandle,
          liveUrl,
          status: "awaiting_capture",
          chunks: 0,
          seconds: 0,
          startedAt: Date.now(),
          error: null,
          fileName: null,
          writePending: false,
        },
      }));
      ensureTicker();
    },
    [ensureTicker],
  );

  const cancelAwaitingCapture = useCallback(
    (sessionId: string) => {
      const state = states[sessionId];
      if (!state || state.status !== "awaiting_capture") return;
      const rt = runtimes.current.get(sessionId);
      if (rt?.popupWindow && !rt.popupWindow.closed) {
        try {
          rt.popupWindow.close();
        } catch {
          /* ignore */
        }
      }
      runtimes.current.delete(sessionId);
      setStates((s) => {
        const n = { ...s };
        delete n[sessionId];
        return n;
      });
    },
    [states],
  );

  const beginCapture = useCallback(
    async (sessionId: string) => {
      const rt = runtimes.current.get(sessionId);
      const state = states[sessionId];
      if (!rt || !state) return;

      // 1. Checa suporte do File System Access API.
      if (typeof window.showSaveFilePicker !== "function") {
        updateState(sessionId, {
          status: "error",
          error:
            "Seu navegador não suporta gravação local. Use Chrome, Edge ou Opera no desktop.",
        });
        runtimes.current.delete(sessionId);
        return;
      }

      // 2. Pede onde salvar o arquivo .webm.
      const suggestedName = sanitizeFileName(state.hostHandle);
      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName,
          types: [
            {
              description: "Vídeo WebM",
              accept: { "video/webm": [".webm"] },
            },
          ],
        });
      } catch (err) {
        const aborted =
          err instanceof Error && err.name === "AbortError";
        if (aborted) {
          runtimes.current.delete(sessionId);
          setStates((s) => {
            const n = { ...s };
            delete n[sessionId];
            return n;
          });
          return;
        }
        updateState(sessionId, {
          status: "error",
          error: err instanceof Error ? err.message : "save_picker_failed",
        });
        runtimes.current.delete(sessionId);
        return;
      }

      // 3. Pede a aba/janela pra capturar.
      //    - suppressLocalAudioPlayback: captura áudio da aba mas silencia
      //      o playback local — você não precisa ouvir a live enquanto grava.
      //    - systemAudio: 'exclude' garante que sons de outras abas/sistema
      //      não entrem mesmo se user escolher "tela inteira" por engano.
      let rawStream: MediaStream;
      try {
        rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30, max: 30 },
          } as MediaTrackConstraints,
          audio: {
            suppressLocalAudioPlayback: true,
          } as MediaTrackConstraints & {
            suppressLocalAudioPlayback?: boolean;
          },
          systemAudio: "exclude",
          selfBrowserSurface: "exclude",
        } as DisplayMediaStreamOptions & {
          systemAudio?: "include" | "exclude";
          selfBrowserSurface?: "include" | "exclude";
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "capture_denied";
        updateState(sessionId, { status: "error", error: message });
        runtimes.current.delete(sessionId);
        return;
      }

      if (rawStream.getAudioTracks().length === 0) {
        updateState(sessionId, {
          status: "error",
          error:
            'Sem áudio capturado. Ao escolher a aba, marque "Compartilhar áudio da aba".',
        });
        for (const t of rawStream.getTracks()) t.stop();
        runtimes.current.delete(sessionId);
        return;
      }

      // 4. Abre writable pro arquivo.
      let writable: FileSystemWritableFileStream;
      try {
        writable = await fileHandle.createWritable();
      } catch (err) {
        updateState(sessionId, {
          status: "error",
          error: err instanceof Error ? err.message : "writable_failed",
        });
        for (const t of rawStream.getTracks()) t.stop();
        runtimes.current.delete(sessionId);
        return;
      }

      // 5. Pipeline de crop 9:16:
      //    getDisplayMedia → <video> offscreen → canvas 540x960 com center-crop
      //    → canvas.captureStream() → combinado com áudio original
      //    → MediaRecorder
      const videoEl = document.createElement("video");
      videoEl.srcObject = new MediaStream(rawStream.getVideoTracks());
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.style.position = "fixed";
      videoEl.style.top = "-9999px";
      videoEl.style.left = "-9999px";
      videoEl.style.width = "1px";
      videoEl.style.height = "1px";
      videoEl.style.opacity = "0";
      document.body.appendChild(videoEl);
      try {
        await videoEl.play();
      } catch {
        /* autoplay muted deve sempre passar; se falhar, drawImage só pula frames até ter data */
      }

      const canvas = document.createElement("canvas");
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        updateState(sessionId, {
          status: "error",
          error: "canvas 2d context indisponível",
        });
        for (const t of rawStream.getTracks()) t.stop();
        videoEl.remove();
        void writable.close().catch(() => null);
        runtimes.current.delete(sessionId);
        return;
      }
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, OUT_W, OUT_H);

      const targetAspect = OUT_W / OUT_H; // 0.5625
      const hasRVFC =
        typeof (videoEl as HTMLVideoElement & {
          requestVideoFrameCallback?: unknown;
        }).requestVideoFrameCallback === "function";
      const drawFrame = () => {
        if (rt.stopped) return;
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (vw > 0 && vh > 0) {
          const srcAspect = vw / vh;
          let sx = 0,
            sy = 0,
            sw = vw,
            sh = vh;
          if (srcAspect > targetAspect) {
            // fonte mais larga → crop laterais, mantém altura toda
            sw = vh * targetAspect;
            sx = (vw - sw) / 2;
          } else if (srcAspect < targetAspect) {
            // fonte mais alta → crop topo/base, mantém largura toda
            sh = vw / targetAspect;
            sy = (vh - sh) / 2;
          }
          ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H);
        }
        // rVFC dispara por frame decodificado (não throttla em bg tab);
        // cai pra rAF se navegador não suportar.
        if (hasRVFC) {
          videoEl.requestVideoFrameCallback(drawFrame);
        } else {
          rt.cropRaf = window.requestAnimationFrame(drawFrame);
        }
      };
      if (hasRVFC) {
        videoEl.requestVideoFrameCallback(drawFrame);
      } else {
        rt.cropRaf = window.requestAnimationFrame(drawFrame);
      }

      const canvasStream = canvas.captureStream(30);
      const combined = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...rawStream.getAudioTracks(),
      ]);

      rt.rawStream = rawStream;
      rt.canvasStream = canvasStream;
      rt.videoEl = videoEl;
      rt.stream = combined;
      rt.writable = writable;
      rt.fileHandle = fileHandle;

      // 6. MediaRecorder grava o stream COMBINADO (vídeo cropado + áudio).
      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, {
          mimeType,
          videoBitsPerSecond: 2_500_000,
          audioBitsPerSecond: 128_000,
        });
      } catch (err) {
        updateState(sessionId, {
          status: "error",
          error: err instanceof Error ? err.message : "recorder_failed",
        });
        for (const t of rawStream.getTracks()) t.stop();
        for (const t of canvasStream.getTracks()) t.stop();
        videoEl.remove();
        void writable.close().catch(() => null);
        runtimes.current.delete(sessionId);
        return;
      }
      rt.recorder = recorder;

      const fileName = fileHandle.name;
      await postMetadata(sessionId, "start", { fileName });
      updateState(sessionId, {
        status: "recording",
        startedAt: Date.now(),
        fileName,
      });

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size < 1_000) return;
        // Enfileira a escrita — cada write aguarda a anterior.
        // FileSystemWritableFileStream grava sequencialmente sem buffer
        // intermediário, então escrever um chunk de ~10MB direto é OK.
        setStates((s) => {
          const prev = s[sessionId];
          if (!prev) return s;
          return {
            ...s,
            [sessionId]: {
              ...prev,
              chunks: prev.chunks + 1,
              seconds: prev.seconds + Math.round(CHUNK_MS / 1000),
              writePending: true,
            },
          };
        });
        rt.writeQueue = rt.writeQueue
          .then(() => writable.write(event.data))
          .then(() => {
            rt.secondsWritten += Math.round(CHUNK_MS / 1000);
            setStates((s) => {
              const prev = s[sessionId];
              if (!prev) return s;
              return {
                ...s,
                [sessionId]: { ...prev, writePending: false },
              };
            });
            const nowMs = Date.now();
            if (nowMs - rt.lastProgressReportedAt > 60_000) {
              rt.lastProgressReportedAt = nowMs;
              void postMetadata(sessionId, "progress", {
                durationSeconds: rt.secondsWritten,
              });
            }
          })
          .catch((err) => {
            console.error("write failed", err);
            setStates((s) => {
              const prev = s[sessionId];
              if (!prev) return s;
              return {
                ...s,
                [sessionId]: {
                  ...prev,
                  writePending: false,
                  error: `Falha ao escrever no arquivo: ${err instanceof Error ? err.message : "unknown"}`,
                },
              };
            });
          });
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error", event);
      };

      // Track ended → usuário fechou a aba do TikTok ou clicou "Parar
      // de compartilhar". Detectamos no track RAW (canvas stream não encerra
      // por conta própria).
      const rawVideoTrack = rawStream.getVideoTracks()[0];
      if (rawVideoTrack) {
        rawVideoTrack.onended = () => {
          if (!rt.stopped) {
            rt.stopped = true;
            void finalize(sessionId);
          }
        };
      }

      recorder.start(CHUNK_MS);
    },
    [finalize, states, updateState],
  );

  const stopRecording = useCallback(
    (sessionId: string) => {
      const rt = runtimes.current.get(sessionId);
      if (!rt || rt.stopped) return;
      rt.stopped = true;
      void finalize(sessionId);
    },
    [finalize],
  );

  // Se o user fechar a aba do dashboard enquanto grava: fecha o writable
  // pra garantir que o arquivo local seja válido (não atualiza DB porque
  // sendBeacon não segura). O usuário ainda fica com o .webm no disco.
  useEffect(() => {
    const handler = () => {
      for (const [sessionId, rt] of runtimes.current) {
        try {
          if (rt.recorder && rt.recorder.state !== "inactive") {
            rt.recorder.stop();
          }
        } catch {
          /* ignore */
        }
        if (rt.writable) {
          // close() é async mas pagehide não espera. Browser tenta flush
          // buffer pendente; arquivo no disco costuma sobreviver intacto.
          void rt.writable.close().catch(() => null);
        }
        navigator.sendBeacon?.(
          `/api/ugc/lives/${sessionId}/local-recording`,
          new Blob(
            [
              JSON.stringify({
                event: "stop",
                durationSeconds: rt.secondsWritten,
              }),
            ],
            { type: "application/json" },
          ),
        );
      }
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, []);

  const isRecording = useCallback(
    (sessionId: string) => runtimes.current.has(sessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [states],
  );

  const getState = useCallback(
    (sessionId: string) => states[sessionId],
    [states],
  );

  const value: ContextValue = {
    startRecording,
    cancelAwaitingCapture,
    beginCapture,
    stopRecording,
    isRecording,
    getState,
    activeIds: Object.keys(states),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <RecordingOverlay
        states={states}
        beginCapture={beginCapture}
        cancelAwaitingCapture={cancelAwaitingCapture}
        stopRecording={stopRecording}
        teardownRuntime={(id) => {
          runtimes.current.delete(id);
          setStates((s) => {
            const n = { ...s };
            delete n[id];
            return n;
          });
        }}
      />
    </Ctx.Provider>
  );
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function RecordingOverlay({
  states,
  beginCapture,
  cancelAwaitingCapture,
  stopRecording,
  teardownRuntime,
}: {
  states: Record<string, ActiveRecording>;
  beginCapture: (sessionId: string) => Promise<void>;
  cancelAwaitingCapture: (sessionId: string) => void;
  stopRecording: (sessionId: string) => void;
  teardownRuntime: (sessionId: string) => void;
}) {
  const list = Object.values(states);
  const awaiting = list.find((r) => r.status === "awaiting_capture");
  const errorState = list.find((r) => r.status === "error");
  const recording = list.filter(
    (r) => r.status === "recording" || r.status === "finalizing",
  );

  return (
    <>
      {awaiting && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-white">
              Iniciar gravação local
            </h2>
            <p className="mt-3 text-sm text-neutral-300">
              Abrimos a live de{" "}
              <span className="font-mono text-white">@{awaiting.hostHandle}</span>{" "}
              numa janela 9:16 (layout mobile do TikTok, só o vídeo). Ao
              clicar <strong>Iniciar</strong>, o navegador vai pedir:
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-neutral-400">
              <li>
                <strong>Onde salvar o arquivo .webm</strong> no seu computador
              </li>
              <li>
                <strong>Qual janela capturar</strong> — escolha{" "}
                <em>Janela</em> → a janelinha da live TikTok que abrimos, e
                marque <em>Compartilhar áudio</em>
              </li>
            </ol>
            <p className="mt-3 text-xs text-neutral-500">
              O vídeo final sai em 9:16 (540×960), só o player da live. O
              áudio continua sendo capturado mesmo se você silenciar a
              janela. Sons de outras abas ficam de fora. A janela pode
              ficar num monitor secundário — só não pode ser minimizada.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => cancelAwaitingCapture(awaiting.sessionId)}
                className="rounded-md px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  void beginCapture(awaiting.sessionId);
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
              >
                Iniciar
              </button>
            </div>
          </div>
        </div>
      )}

      {errorState && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-red-900 bg-neutral-950 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-red-400">
              Não foi possível iniciar
            </h2>
            <p className="mt-3 text-sm text-neutral-300">{errorState.error}</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => teardownRuntime(errorState.sessionId)}
                className="rounded-md bg-neutral-800 px-4 py-2 text-sm text-white hover:bg-neutral-700"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {recording.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[90] flex w-80 flex-col gap-2">
          {recording.map((r) => {
            const elapsed = Math.floor((Date.now() - r.startedAt) / 1000);
            const isFinalizing = r.status === "finalizing";
            return (
              <div
                key={r.sessionId}
                className="rounded-lg border border-red-700 bg-neutral-950/95 p-3 shadow-lg backdrop-blur"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        isFinalizing
                          ? "bg-yellow-500"
                          : "animate-pulse bg-red-500"
                      }`}
                    />
                    <span className="truncate font-mono text-sm text-white">
                      @{r.hostHandle}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => stopRecording(r.sessionId)}
                    disabled={isFinalizing}
                    className="rounded-md bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {isFinalizing ? "Salvando…" : "Parar"}
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
                  <span>{formatDuration(elapsed)}</span>
                  <span>
                    {r.chunks} chunk{r.chunks === 1 ? "" : "s"}
                    {r.writePending && " · escrevendo…"}
                  </span>
                </div>
                {r.fileName && (
                  <p className="mt-1 truncate text-[10px] text-neutral-500">
                    {r.fileName}
                  </p>
                )}
                {r.error && (
                  <p className="mt-1 text-xs text-red-400">{r.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
