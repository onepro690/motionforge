"use client";

// Gravação 100% local via File System Access API:
// 1. Usuário clica Gravar → abrimos a live numa nova aba normal do navegador.
//    (Não usamos popup/janela separada porque o Chrome NÃO captura áudio
//    quando o usuário compartilha uma "Janela" — só em "Aba" ou "Tela
//    inteira". Abrir como aba garante que a opção "Aba do Chrome" fique
//    óbvia na seleção do getDisplayMedia.)
// 2. Modal "Iniciar Captura" → chama:
//    a) showSaveFilePicker — user escolhe onde salvar o .webm
//    b) getDisplayMedia — user escolhe a aba do TikTok (com áudio)
// 3. Tela "Selecione a área do vídeo" — usuário arrasta um retângulo
//    trancado em 9:16 sobre um preview do stream pra isolar SÓ o player
//    da live (sem a barra de busca/perfis/header do TikTok). É a única
//    forma confiável: a aba é cross-origin, não dá pra inspecionar a DOM
//    do TikTok pra saber onde o <video> está de verdade.
// 4. MediaRecorder timeslice 30s → cada chunk é escrito DIRETO no arquivo
//    local via FileSystemWritableFileStream. Zero memória acumulada, zero
//    upload, suporta gravações de qualquer tamanho.
// 5. Stop → fecha arquivo + marca DONE no DB (só metadata, sem bytes).
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

// Output 9:16 em 1080p — canvas final que vai pro MediaRecorder.
// 1080x1920 é o padrão de "Full HD vertical" esperado por TikTok/Reels.
// Nota: se a fonte (aba capturada) for menor que 1080 na largura do crop,
// o drawImage vai upscale — sem detalhe novo, mas o container do arquivo
// fica em 1080p (resolução/bitrate do arquivo ficam consistentes).
const OUT_W = 1080;
const OUT_H = 1920;
const TARGET_ASPECT = OUT_W / OUT_H; // 0.5625

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

interface CropRect {
  // Coords em pixels do frame original (source video).
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ActiveRecording {
  sessionId: string;
  hostHandle: string;
  liveUrl: string;
  status:
    | "awaiting_capture"
    | "configuring_crop"
    | "recording"
    | "finalizing"
    | "error";
  chunks: number;
  seconds: number;
  startedAt: number;
  error: string | null;
  fileName: string | null;
  writePending: boolean;
  sourceWidth: number | null;
  sourceHeight: number | null;
}

interface ContextValue {
  startRecording: (
    sessionId: string,
    hostHandle: string,
    onFinish?: () => void,
  ) => void;
  cancelAwaitingCapture: (sessionId: string) => void;
  beginCapture: (sessionId: string) => Promise<void>;
  confirmCrop: (sessionId: string, rect: CropRect) => Promise<void>;
  stopRecording: (sessionId: string) => void;
  isRecording: (sessionId: string) => boolean;
  getState: (sessionId: string) => ActiveRecording | undefined;
  getRawStream: (sessionId: string) => MediaStream | null;
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
  stream: MediaStream | null; // combinado (canvas + aba áudio) → MediaRecorder
  rawStream: MediaStream | null; // getDisplayMedia cru
  canvasStream: MediaStream | null; // captureStream() do canvas
  videoEl: HTMLVideoElement | null; // offscreen, fonte do drawImage
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

  const teardownRuntime = useCallback((sessionId: string) => {
    const rt = runtimes.current.get(sessionId);
    if (rt) {
      try {
        if (rt.recorder && rt.recorder.state !== "inactive") rt.recorder.stop();
      } catch {
        /* ignore */
      }
      if (rt.cropRaf !== null) {
        try {
          cancelAnimationFrame(rt.cropRaf);
        } catch {
          /* ignore */
        }
      }
      for (const s of [rt.rawStream, rt.canvasStream]) {
        if (!s) continue;
        for (const t of s.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
      }
      if (rt.videoEl) {
        try {
          rt.videoEl.pause();
          rt.videoEl.srcObject = null;
          rt.videoEl.remove();
        } catch {
          /* ignore */
        }
      }
      if (rt.writable) {
        void rt.writable.close().catch(() => null);
      }
      if (rt.popupWindow && !rt.popupWindow.closed) {
        try {
          rt.popupWindow.close();
        } catch {
          /* cross-origin: ignore */
        }
      }
    }
    runtimes.current.delete(sessionId);
    setStates((s) => {
      const n = { ...s };
      delete n[sessionId];
      return n;
    });
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
          // Dá tempo pro último ondataavailable enfileirar a escrita final.
          await new Promise((r) => setTimeout(r, 500));
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

      // Abre como aba normal (sem `popup=yes`): o Chrome só captura áudio
      // quando compartilhamos uma "Aba" ou "Tela inteira" — NÃO captura em
      // "Janela". Se abríssemos como popup window, o usuário tenderia a
      // selecionar essa janela, perdendo o áudio.
      // Sem `noopener`/`noreferrer` pra manter a referência da janela e
      // poder fechar no stop.
      let popupWindow: Window | null = null;
      try {
        popupWindow = window.open(liveUrl, "_blank");
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
          sourceWidth: null,
          sourceHeight: null,
        },
      }));
      ensureTicker();
    },
    [ensureTicker],
  );

  const cancelAwaitingCapture = useCallback(
    (sessionId: string) => {
      const state = states[sessionId];
      if (
        !state ||
        (state.status !== "awaiting_capture" &&
          state.status !== "configuring_crop")
      ) {
        return;
      }
      teardownRuntime(sessionId);
    },
    [states, teardownRuntime],
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
        const aborted = err instanceof Error && err.name === "AbortError";
        if (aborted) {
          teardownRuntime(sessionId);
          return;
        }
        updateState(sessionId, {
          status: "error",
          error: err instanceof Error ? err.message : "save_picker_failed",
        });
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
            // Hint pro Chrome capturar em alta resolução. Tab capture
            // normalmente entrega na resolução renderizada da aba; esses
            // ideals só ajudam quando o Chrome tem margem pra subir.
            width: { ideal: 2560 },
            height: { ideal: 1440 },
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
        return;
      }

      // O Chrome NÃO captura áudio em modo "Janela" — só em "Aba" ou "Tela
      // inteira". Se o usuário escolheu janela, o stream vem sem audio tracks.
      if (rawStream.getAudioTracks().length === 0) {
        for (const t of rawStream.getTracks()) t.stop();
        updateState(sessionId, {
          status: "error",
          error:
            'Sem áudio. Você selecionou uma "Janela" — o Chrome não captura áudio nesse modo. Refaça e escolha a opção "Aba do Chrome" (a aba do TikTok que abrimos) e marque "Compartilhar áudio da aba".',
        });
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
        return;
      }

      // 5. Guarda o stream + writable no runtime e passa pra fase de crop.
      //    O canvas/recorder só são criados em confirmCrop, depois do
      //    usuário selecionar a área do vídeo.
      rt.rawStream = rawStream;
      rt.writable = writable;
      rt.fileHandle = fileHandle;

      // Detecta resolução da fonte pra alimentar o preview do crop.
      // Usa um video temporário só pra ler videoWidth/videoHeight. Depois
      // é descartado; confirmCrop cria o videoEl offscreen final.
      const probe = document.createElement("video");
      probe.srcObject = new MediaStream(rawStream.getVideoTracks());
      probe.muted = true;
      probe.playsInline = true;
      probe.style.position = "fixed";
      probe.style.top = "-9999px";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);
      try {
        await probe.play();
      } catch {
        /* ignore */
      }
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve({ w: probe.videoWidth || 0, h: probe.videoHeight || 0 });
        };
        if (probe.videoWidth > 0 && probe.videoHeight > 0) {
          done();
          return;
        }
        probe.addEventListener("loadedmetadata", done);
        setTimeout(done, 3000);
      });
      probe.pause();
      probe.srcObject = null;
      probe.remove();

      if (dims.w === 0 || dims.h === 0) {
        updateState(sessionId, {
          status: "error",
          error:
            "Não foi possível ler a resolução do stream. Tente novamente.",
        });
        for (const t of rawStream.getTracks()) t.stop();
        try {
          await writable.close();
        } catch {
          /* ignore */
        }
        return;
      }

      // Se o track raw for interrompido (user fechou a aba ou clicou "Parar
      // de compartilhar" ANTES de confirmar o crop), aborta de vez.
      const rawVideoTrack = rawStream.getVideoTracks()[0];
      if (rawVideoTrack) {
        rawVideoTrack.onended = () => {
          const current = runtimes.current.get(sessionId);
          if (!current) return;
          if (current.recorder) {
            // Já estava gravando → finalize normal.
            if (!current.stopped) {
              current.stopped = true;
              void finalize(sessionId);
            }
          } else {
            // Ainda na fase de crop → aborta.
            teardownRuntime(sessionId);
          }
        };
      }

      updateState(sessionId, {
        status: "configuring_crop",
        fileName: fileHandle.name,
        sourceWidth: dims.w,
        sourceHeight: dims.h,
      });
    },
    [finalize, states, teardownRuntime, updateState],
  );

  const confirmCrop = useCallback(
    async (sessionId: string, crop: CropRect) => {
      const rt = runtimes.current.get(sessionId);
      const state = states[sessionId];
      if (!rt || !state || state.status !== "configuring_crop") return;
      if (!rt.rawStream || !rt.writable || !rt.fileHandle) return;

      const rawStream = rt.rawStream;
      const writable = rt.writable;
      const fileHandle = rt.fileHandle;

      // Converte o crop (em pixels da fonte, como vistos no preview) pra
      // coordenadas normalizadas [0-1]. A dimensão real do videoEl em
      // runtime pode diferir da lida pelo probe (tab capture pode mudar
      // resolução após resize da janela ou devicePixelRatio), então
      // guardar o crop em proporção torna ele resolução-independente.
      const probeW = state.sourceWidth ?? 0;
      const probeH = state.sourceHeight ?? 0;
      if (probeW === 0 || probeH === 0) return;
      const nx = Math.max(0, Math.min(1, crop.x / probeW));
      const ny = Math.max(0, Math.min(1, crop.y / probeH));
      const nw = Math.max(0.01, Math.min(1 - nx, crop.w / probeW));
      const nh = Math.max(0.01, Math.min(1 - ny, crop.h / probeH));

      // 1. videoEl offscreen recebe o track raw.
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
        /* autoplay muted deve sempre passar; drawImage pula frames até ter data */
      }

      // 2. Canvas 540x960 → drawImage com o crop escolhido pelo user.
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

      const hasRVFC =
        typeof (videoEl as HTMLVideoElement & {
          requestVideoFrameCallback?: unknown;
        }).requestVideoFrameCallback === "function";
      const drawFrame = () => {
        if (rt.stopped) return;
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (vw > 0 && vh > 0) {
          // Denormaliza o crop usando as dimensões ATUAIS do track. Se o
          // source tiver mudado de 1920x1080 pra 1280x720 entre probe e
          // gravação, o crop continua apontando pra mesma região visual.
          const cx = Math.max(0, Math.min(Math.round(nx * vw), vw - 1));
          const cy = Math.max(0, Math.min(Math.round(ny * vh), vh - 1));
          const cw = Math.max(1, Math.min(Math.round(nw * vw), vw - cx));
          const ch = Math.max(1, Math.min(Math.round(nh * vh), vh - cy));
          ctx.drawImage(videoEl, cx, cy, cw, ch, 0, 0, OUT_W, OUT_H);
        }
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

      rt.canvasStream = canvasStream;
      rt.videoEl = videoEl;
      rt.stream = combined;

      // 3. MediaRecorder grava o stream combinado (vídeo cropado + áudio).
      const mimeType = pickMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, {
          mimeType,
          // 1080p 30fps em vp9 fica limpo em ~8Mbps. vp8 precisa de mais;
          // como fallback pro vp8 mantém 8Mbps (um pouco pior mas ok).
          videoBitsPerSecond: 8_000_000,
          audioBitsPerSecond: 192_000,
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
                  error: `Falha ao escrever no arquivo: ${
                    err instanceof Error ? err.message : "unknown"
                  }`,
                },
              };
            });
          });
      };

      recorder.onerror = (event) => {
        console.error("MediaRecorder error", event);
      };

      recorder.start(CHUNK_MS);
    },
    [states, updateState],
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
  // pra garantir que o arquivo local seja válido.
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

  const getRawStream = useCallback((sessionId: string) => {
    return runtimes.current.get(sessionId)?.rawStream ?? null;
  }, []);

  const value: ContextValue = {
    startRecording,
    cancelAwaitingCapture,
    beginCapture,
    confirmCrop,
    stopRecording,
    isRecording,
    getState,
    getRawStream,
    activeIds: Object.keys(states),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <RecordingOverlay
        states={states}
        beginCapture={beginCapture}
        confirmCrop={confirmCrop}
        cancelAwaitingCapture={cancelAwaitingCapture}
        stopRecording={stopRecording}
        getRawStream={getRawStream}
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
  confirmCrop,
  cancelAwaitingCapture,
  stopRecording,
  getRawStream,
  teardownRuntime,
}: {
  states: Record<string, ActiveRecording>;
  beginCapture: (sessionId: string) => Promise<void>;
  confirmCrop: (sessionId: string, rect: CropRect) => Promise<void>;
  cancelAwaitingCapture: (sessionId: string) => void;
  stopRecording: (sessionId: string) => void;
  getRawStream: (sessionId: string) => MediaStream | null;
  teardownRuntime: (sessionId: string) => void;
}) {
  const list = Object.values(states);
  const awaiting = list.find((r) => r.status === "awaiting_capture");
  const configuring = list.find((r) => r.status === "configuring_crop");
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
              <span className="font-mono text-white">
                @{awaiting.hostHandle}
              </span>{" "}
              numa nova aba. Ao clicar <strong>Iniciar</strong>, o navegador
              vai pedir:
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-neutral-400">
              <li>
                <strong>Onde salvar o arquivo .webm</strong> no seu computador.
              </li>
              <li>
                <strong>Qual aba capturar.</strong> Na janelinha do Chrome,
                escolha a aba <em>&quot;Aba do Chrome&quot;</em> (
                <span className="text-yellow-300">não Janela!</span>) →
                selecione a aba do TikTok que abrimos, e marque{" "}
                <strong>&quot;Compartilhar áudio da aba&quot;</strong>. O áudio
                só funciona no modo <em>Aba</em>.
              </li>
              <li>
                Depois você desenha o retângulo 9:16 sobre o vídeo da live,
                pra recortar fora a barra de busca / perfis do TikTok.
              </li>
            </ol>
            <p className="mt-3 text-xs text-neutral-500">
              O áudio continua sendo capturado mesmo se você silenciar a aba
              do TikTok. Sons de outras abas ficam de fora. A aba pode ficar
              em outro monitor — só não pode ser minimizada.
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

      {configuring && configuring.sourceWidth && configuring.sourceHeight && (
        <CropConfigurator
          rec={configuring}
          rawStream={getRawStream(configuring.sessionId)}
          onConfirm={(rect) => {
            void confirmCrop(configuring.sessionId, rect);
          }}
          onCancel={() => cancelAwaitingCapture(configuring.sessionId)}
        />
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

// ============================================================================
// CropConfigurator
// ============================================================================
// Mostra o preview do stream capturado e deixa o user arrastar um retângulo
// trancado em 9:16 sobre o vídeo da live pra isolar só o player (sem a UI
// do TikTok ao redor).
//
// Por que manual: a aba do TikTok é cross-origin, então não temos como
// inspecionar a DOM dela pra achar a posição real do <video>. O
// `preferCurrentTab` ou algum observer do player não resolve. O user
// desenha 1 vez e a gente aplica esse crop no drawImage do canvas.
// ============================================================================

function CropConfigurator({
  rec,
  rawStream,
  onConfirm,
  onCancel,
}: {
  rec: ActiveRecording;
  rawStream: MediaStream | null;
  onConfirm: (rect: CropRect) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const [rect, setRect] = useState<CropRect | null>(null);
  const gestureRef = useRef<{
    mode: "idle" | "move" | "resize";
    pointerId: number | null;
    ax: number;
    ay: number;
    rx: number;
    ry: number;
    rw: number;
    rh: number;
  }>({
    mode: "idle",
    pointerId: null,
    ax: 0,
    ay: 0,
    rx: 0,
    ry: 0,
    rw: 0,
    rh: 0,
  });

  const vw = rec.sourceWidth ?? 0;
  const vh = rec.sourceHeight ?? 0;

  // Anexa o stream ao preview.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !rawStream) return;
    v.srcObject = new MediaStream(rawStream.getVideoTracks());
    v.muted = true;
    v.playsInline = true;
    void v.play().catch(() => null);
    return () => {
      try {
        v.pause();
        v.srcObject = null;
      } catch {
        /* noop */
      }
    };
  }, [rawStream]);

  // Observa o tamanho renderizado do frame (o div com aspect-ratio do video).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = () => {
      setFrameSize({ w: el.clientWidth, h: el.clientHeight });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vw, vh]);

  // Inicializa o retângulo 9:16 centralizado ocupando ~90% do lado menor.
  useEffect(() => {
    if (vw === 0 || vh === 0 || rect) return;
    let cw: number;
    let ch: number;
    const srcAspect = vw / vh;
    if (srcAspect > TARGET_ASPECT) {
      // fonte mais larga (ex: desktop 16:9) → altura determina
      ch = vh * 0.9;
      cw = ch * TARGET_ASPECT;
    } else {
      // fonte mais alta ou igual → largura determina
      cw = vw * 0.9;
      ch = cw / TARGET_ASPECT;
    }
    setRect({
      x: Math.round((vw - cw) / 2),
      y: Math.round((vh - ch) / 2),
      w: Math.round(cw),
      h: Math.round(ch),
    });
  }, [vw, vh, rect]);

  const scale = frameSize.w > 0 && vw > 0 ? frameSize.w / vw : 0;

  const clientToSource = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      const el = frameRef.current;
      if (!el || scale === 0) return null;
      const box = el.getBoundingClientRect();
      const px = (clientX - box.left) / scale;
      const py = (clientY - box.top) / scale;
      return [px, py];
    },
    [scale],
  );

  const onBodyPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
    if (!rect) return;
    e.preventDefault();
    const pt = clientToSource(e.clientX, e.clientY);
    if (!pt) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    gestureRef.current = {
      mode: "move",
      pointerId: e.pointerId,
      ax: pt[0],
      ay: pt[1],
      rx: rect.x,
      ry: rect.y,
      rw: rect.w,
      rh: rect.h,
    };
  };

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = clientToSource(e.clientX, e.clientY);
    if (!pt) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    gestureRef.current = {
      mode: "resize",
      pointerId: e.pointerId,
      ax: pt[0],
      ay: pt[1],
      rx: rect.x,
      ry: rect.y,
      rw: rect.w,
      rh: rect.h,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.mode === "idle" || !rect) return;
    if (g.pointerId !== null && g.pointerId !== e.pointerId) return;
    const pt = clientToSource(e.clientX, e.clientY);
    if (!pt) return;
    const dx = pt[0] - g.ax;
    const dy = pt[1] - g.ay;

    if (g.mode === "move") {
      let nx = g.rx + dx;
      let ny = g.ry + dy;
      nx = Math.max(0, Math.min(nx, vw - g.rw));
      ny = Math.max(0, Math.min(ny, vh - g.rh));
      setRect({ x: nx, y: ny, w: g.rw, h: g.rh });
    } else {
      // resize ancorado no canto top-left de g.rx/g.ry, trancado em 9:16.
      // Usa a maior variação (dx ou dy * aspect) pra decidir o novo tamanho.
      let nw = g.rw + dx;
      let nh = g.rh + dy;
      // trava aspect pelo eixo que cresceu mais em proporção
      if (nw / TARGET_ASPECT > nh) {
        nh = nw / TARGET_ASPECT;
      } else {
        nw = nh * TARGET_ASPECT;
      }
      // clampa contra as bordas
      const maxW = vw - g.rx;
      const maxH = vh - g.ry;
      if (nw > maxW) {
        nw = maxW;
        nh = nw / TARGET_ASPECT;
      }
      if (nh > maxH) {
        nh = maxH;
        nw = nh * TARGET_ASPECT;
      }
      const minW = Math.max(40, vw * 0.05);
      if (nw < minW) {
        nw = minW;
        nh = nw / TARGET_ASPECT;
      }
      setRect({ x: g.rx, y: g.ry, w: nw, h: nh });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.pointerId !== null && g.pointerId !== e.pointerId) return;
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
    gestureRef.current.mode = "idle";
    gestureRef.current.pointerId = null;
  };

  const handleSize = 22;
  const showRect = rect && frameSize.w > 0;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col gap-3 bg-black/90 p-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-white">
          Selecione a área do vídeo
        </h2>
        <p className="mt-1 text-sm text-neutral-300">
          Arraste o retângulo sobre o vídeo da live (sem incluir a barra do
          TikTok). O canto branco inferior-direito redimensiona. Aspect
          travado em 9:16.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          ref={frameRef}
          className="relative overflow-hidden bg-black"
          style={{
            aspectRatio: vw && vh ? `${vw}/${vh}` : undefined,
            maxHeight: "70vh",
            maxWidth: "100%",
            // Garante que não ultrapasse a viewport horizontalmente.
            width: vw && vh ? `min(100%, calc(70vh * ${vw} / ${vh}))` : "auto",
          }}
        >
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-contain"
          />
          {showRect && rect && (
            <>
              <svg
                ref={svgRef}
                viewBox={`0 0 ${vw} ${vh}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full touch-none select-none"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <path
                  d={`M0,0 H${vw} V${vh} H0 Z M${rect.x},${rect.y} V${rect.y + rect.h} H${rect.x + rect.w} V${rect.y} Z`}
                  fill="rgba(0,0,0,0.55)"
                  fillRule="evenodd"
                  pointerEvents="none"
                />
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.w}
                  height={rect.h}
                  fill="transparent"
                  stroke="white"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: "move" }}
                  onPointerDown={onBodyPointerDown}
                />
              </svg>
              <div
                onPointerDown={onHandlePointerDown}
                onPointerMove={(e) => {
                  // Garante que mover além do elemento ainda funcione após capture.
                  onPointerMove(e);
                }}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="absolute rounded-sm border border-neutral-900 bg-white shadow"
                style={{
                  width: handleSize,
                  height: handleSize,
                  left: (rect.x + rect.w) * scale - handleSize / 2,
                  top: (rect.y + rect.h) * scale - handleSize / 2,
                  cursor: "nwse-resize",
                  touchAction: "none",
                }}
                aria-label="Redimensionar"
              />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!rect}
          onClick={() => rect && onConfirm(rect)}
          className="rounded-md bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
        >
          Começar Gravação
        </button>
      </div>
    </div>
  );
}
