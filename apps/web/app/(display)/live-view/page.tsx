"use client";
import { useRef, useEffect, useState } from "react";
import { SimliClient } from "simli-client";

const CHANNEL = "motionforge-live";

async function resample24kTo16k(base64pcm: string): Promise<Uint8Array> {
  const binary = atob(base64pcm);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const samples24k = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(samples24k.length);
  for (let i = 0; i < samples24k.length; i++) float32[i] = samples24k[i] / 32768;

  const targetLength = Math.ceil(float32.length * 16000 / 24000);
  const offline = new OfflineAudioContext(1, targetLength, 16000);
  const buf = offline.createBuffer(1, float32.length, 24000);
  buf.copyToChannel(float32, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  const ch = rendered.getChannelData(0);
  const int16 = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32768)));
  }
  return new Uint8Array(int16.buffer);
}

type Status = "idle" | "connecting" | "ready" | "error";

export default function LiveViewPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliRef = useRef<SimliClient | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const speakingRef = useRef(false);
  const queueRef = useRef<string[]>([]);

  const processQueue = async () => {
    if (speakingRef.current || queueRef.current.length === 0) return;
    speakingRef.current = true;
    while (queueRef.current.length > 0) {
      const text = queueRef.current.shift()!;
      try {
        const res = await fetch("/api/simli/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const { audio, error: ttsErr } = await res.json();
        if (ttsErr) throw new Error(ttsErr);
        const pcm16 = await resample24kTo16k(audio);
        simliRef.current?.sendAudioData(pcm16);
        // wait for audio to finish before sending next
        const durationMs = (pcm16.length / 2 / 16000) * 1000 + 300;
        await new Promise((r) => setTimeout(r, durationMs));
      } catch (e) {
        console.error("[Simli] TTS/send error:", e);
      }
    }
    speakingRef.current = false;
  };

  const initSimli = async (faceId: string) => {
    setStatus("connecting");
    setError("");

    if (simliRef.current) {
      await simliRef.current.stop().catch(() => {});
      simliRef.current = null;
    }

    try {
      const res = await fetch("/api/simli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faceId }),
      });
      const { session_token, error: err } = await res.json();
      if (err) throw new Error(err);

      // Use "livekit" transport — p2p requires ICE servers (not passed here)
      const client = new SimliClient(
        session_token,
        videoRef.current!,
        audioRef.current!,
        null,
        undefined,
        "livekit" as any,
      );

      client.on("start", () => {
        console.log("[Simli] connected");
        setStatus("ready");
      });

      client.on("error", (detail) => {
        console.error("[Simli] error event:", detail);
        setStatus("error");
        setError(detail ?? "Erro na conexão Simli");
      });

      client.on("startup_error", (msg) => {
        console.error("[Simli] startup_error:", msg);
        setStatus("error");
        setError(msg ?? "Falha ao iniciar avatar");
      });

      client.on("stop", () => {
        console.log("[Simli] stopped");
        setStatus("idle");
      });

      simliRef.current = client;
      await client.start();
      // setStatus("ready") is handled by the "start" event above
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Simli] init error:", msg);
      setStatus("error");
      setError(msg || "Erro ao iniciar Simli");
    }
  };

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);

    channel.onmessage = async (e) => {
      const { type, payload } = e.data ?? {};
      if (type === "init") {
        await initSimli(payload.faceId);
      } else if (type === "speak" && simliRef.current) {
        queueRef.current.push(payload.text);
        processQueue();
      } else if (type === "stop") {
        await simliRef.current?.stop().catch(() => {});
        simliRef.current = null;
        setStatus("idle");
      }
    };

    return () => channel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center overflow-hidden relative">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="w-full h-full object-cover"
      />
      <audio ref={audioRef} autoPlay hidden />

      {status === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/40">
          <div className="w-2 h-2 rounded-full bg-white/20 animate-pulse" />
          <p className="text-sm font-medium">Aguardando painel de controle...</p>
          <p className="text-xs text-white/20">Clique em "Abrir Live View" no painel</p>
        </div>
      )}

      {status === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60">
          <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          <p className="text-sm font-medium">Conectando avatar...</p>
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-red-400 text-sm bg-red-500/10 px-4 py-2 rounded-lg max-w-sm text-center">{error}</p>
        </div>
      )}
    </div>
  );
}
