"use client";

// Provider de gravação de lives que sobrevive à navegação entre seções
// do dashboard. O loop de chunks roda neste contexto (montado no layout
// do dashboard), não no componente da página de lives — então trocar de
// aba (/ugc/lives → /ugc/products) não aborta a gravação.
//
// O cron /api/cron/record-lives continua sendo o fallback definitivo pra
// quando a aba é fechada. Este provider existe pra garantir chunks rápidos
// (45s) enquanto o usuário navega livremente pelo app.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

interface RecordingState {
  chunks: number;
  seconds: number;
  startedAt: number;
  finalizing: boolean;
}

interface ContextValue {
  startRecording: (sessionId: string, onFinish?: () => void) => Promise<void>;
  stopRecording: (sessionId: string) => void;
  getState: (sessionId: string) => RecordingState | undefined;
  isRecording: (sessionId: string) => boolean;
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

export function LiveRecordingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [states, setStates] = useState<Record<string, RecordingState>>({});
  const stopFlags = useRef<Map<string, boolean>>(new Map());
  const runningIds = useRef<Set<string>>(new Set());
  // Ticker pra atualizar seconds elapsed na UI
  const [, setTick] = useState(0);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const ensureTicker = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setInterval(() => {
      if (runningIds.current.size === 0) {
        if (tickTimer.current) {
          clearInterval(tickTimer.current);
          tickTimer.current = null;
        }
        return;
      }
      setTick((t) => t + 1);
    }, 1000);
  }, []);

  const startRecording = useCallback(
    async (sessionId: string, onFinish?: () => void) => {
      // Evita dois loops pro mesmo sessionId (ex: dupla clicada)
      if (runningIds.current.has(sessionId)) return;
      runningIds.current.add(sessionId);
      stopFlags.current.set(sessionId, false);

      setStates((s) => ({
        ...s,
        [sessionId]: {
          chunks: 0,
          seconds: 0,
          startedAt: Date.now(),
          finalizing: false,
        },
      }));
      ensureTicker();

      let consecutiveErrors = 0;
      let isFirstCall = true;
      // Razão pela qual o loop parou — só finaliza se for iniciativa do
      // usuário (Parar) ou confirmação do TikTok (live acabou).
      // Erro de rede/auth NÃO finaliza — deixa cron/chain continuarem.
      // "already_finalized" significa que chain/cron já finalizou — loop
      // sai sem disparar finalize extra (que apagaria a recording).
      let reasonToFinalize: "user_stop" | "live_ended" | null = null;
      try {
        while (!stopFlags.current.get(sessionId)) {
          const payload: { durationSeconds: number; restart?: boolean } = {
            durationSeconds: 45,
          };
          if (isFirstCall) {
            payload.restart = true;
            isFirstCall = false;
          }
          // Abort após 75s: se servidor trava, não queremos esperar os 300s
          // inteiros do timeout da função — isso gastava 5min por erro e o
          // loop desistia em 25min (5 erros × 5min). Chunk normal é ~45s
          // + 10-15s overhead; 75s cobre o feliz caminho com folga.
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), 75_000);
          const res = await fetch(
            `/api/ugc/lives/${sessionId}/record-now`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            },
          ).catch(() => null);
          clearTimeout(abortTimer);

          if (stopFlags.current.get(sessionId)) {
            reasonToFinalize = "user_stop";
            break;
          }

          if (!res || !res.ok) {
            let stillLiveReported: boolean | undefined;
            let errorCode: string | undefined;
            if (res) {
              const text = await res.text().catch(() => "");
              try {
                const j = JSON.parse(text) as { stillLive?: boolean; error?: string };
                if (typeof j.stillLive === "boolean") stillLiveReported = j.stillLive;
                if (typeof j.error === "string") errorCode = j.error;
              } catch {
                /* ignore parse err */
              }
            }
            // Chain/cron já finalizou: sai do loop sem chamar finalize.
            if (errorCode === "already_finalized") {
              break;
            }
            // Só finaliza se servidor confirmou explicitamente !stillLive.
            if (stillLiveReported === false) {
              reasonToFinalize = "live_ended";
              break;
            }
            consecutiveErrors++;
            // Tolera muito mais erros: cron roda a cada 2min, e erros
            // transientes (timeout, WAF TikTok, network) não devem matar
            // o loop. 60 erros × 3s = 3min de recuperação antes de desistir.
            if (consecutiveErrors >= 60) {
              break;
            }
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          consecutiveErrors = 0;

          const json = (await res.json()) as {
            chunkSeconds?: number;
            cumulativeSeconds?: number;
            stillLive?: boolean;
          };
          setStates((s) => {
            const prev = s[sessionId];
            if (!prev) return s;
            return {
              ...s,
              [sessionId]: {
                ...prev,
                chunks: prev.chunks + 1,
                seconds: json.cumulativeSeconds ?? prev.seconds,
              },
            };
          });
          if (json.stillLive === false) {
            reasonToFinalize = "live_ended";
            break;
          }
          if (stopFlags.current.get(sessionId)) {
            reasonToFinalize = "user_stop";
            break;
          }
        }

        if (reasonToFinalize) {
          setStates((s) => {
            const prev = s[sessionId];
            if (!prev) return s;
            return { ...s, [sessionId]: { ...prev, finalizing: true } };
          });
          // live_ended vem de UMA leitura isLiveActive (pode ser flap transiente
          // do TikTok). Pede confirmFirst pra servidor re-verificar com gap 15s
          // antes de concatenar — se flap, chain continua gravando.
          // user_stop é explícito: finaliza direto.
          await fetch(`/api/ugc/lives/${sessionId}/record-now`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              finalize: true,
              confirmFirst: reasonToFinalize === "live_ended",
            }),
          }).catch(() => null);
        }
        // Se reasonToFinalize === null (erros de rede no cliente), o loop
        // para aqui mas a gravação continua no servidor via cron + chain.
      } finally {
        runningIds.current.delete(sessionId);
        stopFlags.current.delete(sessionId);
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
    [ensureTicker],
  );

  const stopRecording = useCallback((sessionId: string) => {
    if (!runningIds.current.has(sessionId)) return;
    stopFlags.current.set(sessionId, true);
    setStates((s) => {
      const prev = s[sessionId];
      if (!prev) return s;
      return { ...s, [sessionId]: { ...prev, finalizing: true } };
    });
  }, []);

  const getState = useCallback(
    (sessionId: string) => states[sessionId],
    [states],
  );
  const isRecording = useCallback(
    (sessionId: string) => runningIds.current.has(sessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [states],
  );

  const value: ContextValue = {
    startRecording,
    stopRecording,
    getState,
    isRecording,
    activeIds: Object.keys(states),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
