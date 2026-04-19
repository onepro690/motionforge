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
      try {
        while (!stopFlags.current.get(sessionId)) {
          const res = await fetch(
            `/api/ugc/lives/${sessionId}/record-now`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ durationSeconds: 45 }),
            },
          ).catch(() => null);

          if (stopFlags.current.get(sessionId)) break;

          if (!res || !res.ok) {
            let stillLive = true;
            if (res) {
              const text = await res.text().catch(() => "");
              try {
                const j = JSON.parse(text) as { stillLive?: boolean };
                if (typeof j.stillLive === "boolean") stillLive = j.stillLive;
              } catch {
                /* ignore parse err */
              }
            }
            if (!stillLive) break;
            consecutiveErrors++;
            if (consecutiveErrors >= 5) break;
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
          if (!json.stillLive) break;
          if (stopFlags.current.get(sessionId)) break;
        }

        // Finaliza: concatena chunks
        setStates((s) => {
          const prev = s[sessionId];
          if (!prev) return s;
          return { ...s, [sessionId]: { ...prev, finalizing: true } };
        });
        await fetch(`/api/ugc/lives/${sessionId}/record-now`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finalize: true }),
        }).catch(() => null);
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
