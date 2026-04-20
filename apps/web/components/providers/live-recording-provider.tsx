"use client";

// Browser-based live recording:
// 1. Usuário clica Gravar → abrimos a live TikTok numa nova aba e exibimos
//    um modal de captura.
// 2. No modal, usuário clica "Iniciar Captura" → chamamos getDisplayMedia
//    e ele escolhe a aba do TikTok (incluindo áudio).
// 3. MediaRecorder grava em timeslice de 30s. Cada chunk é enviado pra
//    /api/ugc/lives/{id}/upload-chunk com um index sequencial.
// 4. Usuário clica Parar (ou fecha a aba da live → track termina) → paramos
//    o recorder, esperamos uploads pendentes, e chamamos /record-now
//    {finalize:true} que concatena binariamente os .webm.part.
//
// Não depende mais de HLS/FLV do TikTok nem de nenhum status JSON — o que
// for renderizado na aba é o que é gravado. Aba pode ficar em monitor
// secundário; throttling do Chrome é por visibilidade (está visível),
// não por foco.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const CHUNK_MS = 30_000;

interface ActiveRecording {
  sessionId: string;
  hostHandle: string;
  liveUrl: string;
  status: "awaiting_capture" | "recording" | "finalizing" | "error";
  chunks: number;
  seconds: number;
  startedAt: number;
  pendingUploads: number;
  error: string | null;
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
  stream: MediaStream | null;
  nextIndex: number;
  pendingUploads: Set<Promise<void>>;
  onFinish?: () => void;
  stopped: boolean;
  tabWindow: Window | null;
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

async function uploadChunk(
  sessionId: string,
  index: number,
  blob: Blob,
  durationMs: number,
): Promise<void> {
  const form = new FormData();
  form.append("chunk", blob);
  form.append("index", String(index));
  form.append("durationMs", String(durationMs));
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < 3) {
    try {
      const res = await fetch(`/api/ugc/lives/${sessionId}/upload-chunk`, {
        method: "POST",
        body: form,
      });
      if (res.ok) return;
      if (res.status === 409) return; // already_finalized — ignora silenciosamente
      lastErr = new Error(`upload status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    attempt++;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw lastErr ?? new Error("upload failed");
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

  const teardownRuntime = useCallback((sessionId: string) => {
    const rt = runtimes.current.get(sessionId);
    if (!rt) return;
    rt.stopped = true;
    try {
      if (rt.recorder && rt.recorder.state !== "inactive") {
        rt.recorder.stop();
      }
    } catch {
      /* noop */
    }
    if (rt.stream) {
      for (const track of rt.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* noop */
        }
      }
    }
    runtimes.current.delete(sessionId);
  }, []);

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
          // Espera uploads pendentes (inclui o chunk final emitido no stop).
          // Damos um pequeno delay para o evento ondataavailable final disparar.
          await new Promise((r) => setTimeout(r, 400));
          const pending = Array.from(rt.pendingUploads);
          await Promise.allSettled(pending);
          if (rt.stream) {
            for (const track of rt.stream.getTracks()) {
              try {
                track.stop();
              } catch {
                /* noop */
              }
            }
          }
        }
        await fetch(`/api/ugc/lives/${sessionId}/record-now`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finalize: true }),
        }).catch(() => null);
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

      // Abre a aba IMEDIATAMENTE, ainda no handler do clique original
      // (senão o popup blocker do navegador bloqueia).
      let tabWindow: Window | null = null;
      try {
        tabWindow = window.open(liveUrl, "_blank", "noopener,noreferrer");
      } catch {
        tabWindow = null;
      }

      runtimes.current.set(sessionId, {
        recorder: null,
        stream: null,
        nextIndex: 0,
        pendingUploads: new Set(),
        onFinish,
        stopped: false,
        tabWindow,
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
          pendingUploads: 0,
          error: null,
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
      if (!rt) return;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30, max: 30 },
          } as MediaTrackConstraints,
          audio: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "capture_denied";
        updateState(sessionId, {
          status: "error",
          error: message,
        });
        runtimes.current.delete(sessionId);
        return;
      }

      if (stream.getAudioTracks().length === 0) {
        updateState(sessionId, {
          status: "error",
          error:
            'Sem áudio capturado. Ao selecionar a aba, marque "Compartilhar áudio da aba" no canto inferior do diálogo.',
        });
        for (const t of stream.getTracks()) t.stop();
        runtimes.current.delete(sessionId);
        return;
      }

      rt.stream = stream;

      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 2_500_000,
          audioBitsPerSecond: 128_000,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "recorder_failed";
        updateState(sessionId, { status: "error", error: message });
        for (const t of stream.getTracks()) t.stop();
        runtimes.current.delete(sessionId);
        return;
      }
      rt.recorder = recorder;

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size < 1_000) return;
        const index = rt.nextIndex++;
        const durationMs = index === 0 ? CHUNK_MS : CHUNK_MS;
        const task = uploadChunk(sessionId, index, event.data, durationMs)
          .then(() => {
            setStates((s) => {
              const prev = s[sessionId];
              if (!prev) return s;
              return {
                ...s,
                [sessionId]: {
                  ...prev,
                  chunks: prev.chunks + 1,
                  seconds: prev.seconds + Math.round(durationMs / 1000),
                  pendingUploads: Math.max(0, prev.pendingUploads - 1),
                },
              };
            });
          })
          .catch((err) => {
            // Falha persistente num chunk: deixa estado marcado mas não
            // interrompe gravação — os outros chunks podem salvar o que der.
            console.error("chunk upload failed", err);
            setStates((s) => {
              const prev = s[sessionId];
              if (!prev) return s;
              return {
                ...s,
                [sessionId]: {
                  ...prev,
                  pendingUploads: Math.max(0, prev.pendingUploads - 1),
                  error: `Falha ao enviar chunk ${index}`,
                },
              };
            });
          })
          .finally(() => {
            rt.pendingUploads.delete(task);
          });
        rt.pendingUploads.add(task);
        setStates((s) => {
          const prev = s[sessionId];
          if (!prev) return s;
          return {
            ...s,
            [sessionId]: {
              ...prev,
              pendingUploads: prev.pendingUploads + 1,
            },
          };
        });
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error", event);
      };

      // Quando o usuário fecha a aba da live ou clica em "Parar de compartilhar"
      // no Chrome, o track emite ended → finaliza automaticamente.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          if (!rt.stopped) {
            void finalize(sessionId);
          }
        };
      }

      recorder.start(CHUNK_MS);
      updateState(sessionId, {
        status: "recording",
        startedAt: Date.now(),
      });
    },
    [finalize, updateState],
  );

  const stopRecording = useCallback(
    (sessionId: string) => {
      const rt = runtimes.current.get(sessionId);
      if (!rt) return;
      if (rt.stopped) return;
      rt.stopped = true;
      void finalize(sessionId);
    },
    [finalize],
  );

  // Persist unload: se o usuário fechar a aba do dashboard enquanto grava,
  // pelo menos tenta disparar o finalize pra consolidar o que já subiu.
  useEffect(() => {
    const handler = () => {
      for (const sessionId of runtimes.current.keys()) {
        navigator.sendBeacon?.(
          `/api/ugc/lives/${sessionId}/record-now`,
          new Blob([JSON.stringify({ finalize: true })], {
            type: "application/json",
          }),
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
        teardownRuntime={teardownRuntime}
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
              Iniciar captura da live
            </h2>
            <p className="mt-3 text-sm text-neutral-300">
              Abrimos a live de{" "}
              <span className="font-mono text-white">@{awaiting.hostHandle}</span>{" "}
              numa nova aba. Clique em <strong>Iniciar Captura</strong> abaixo
              e, no diálogo do navegador:
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-neutral-400">
              <li>
                Escolha <strong>Aba do Chrome</strong> (não a tela inteira)
              </li>
              <li>Selecione a aba da live do TikTok</li>
              <li>
                Marque <strong>Compartilhar áudio da aba</strong>
              </li>
              <li>
                Clique em <strong>Compartilhar</strong>
              </li>
            </ol>
            <p className="mt-3 text-xs text-neutral-500">
              A aba pode ficar num monitor secundário enquanto você usa o
              computador — basta não minimizá-la nem trocar a aba ativa dela.
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
                Iniciar Captura
              </button>
            </div>
          </div>
        </div>
      )}

      {errorState && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-red-900 bg-neutral-950 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-red-400">
              Captura não iniciada
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
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        isFinalizing
                          ? "bg-yellow-500"
                          : "animate-pulse bg-red-500"
                      }`}
                    />
                    <span className="font-mono text-sm text-white">
                      @{r.hostHandle}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => stopRecording(r.sessionId)}
                    disabled={isFinalizing}
                    className="rounded-md bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {isFinalizing ? "Finalizando…" : "Parar"}
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-neutral-400">
                  <span>{formatDuration(elapsed)}</span>
                  <span>
                    {r.chunks} chunks{" "}
                    {r.pendingUploads > 0 && `(${r.pendingUploads} pendente${r.pendingUploads > 1 ? "s" : ""})`}
                  </span>
                </div>
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
