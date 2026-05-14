"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Subtitles, Loader2, Download, Upload, X, Sparkles, ArrowUp, ArrowDown, MoveVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { upload } from "@vercel/blob/client";

type Phase = "idle" | "uploading" | "submitting" | "polling" | "done" | "error";

interface PollResponse {
  id: string;
  status: "QUEUED" | "PROCESSING" | "RENDERING" | "COMPLETED" | "FAILED";
  outputVideoUrl?: string | null;
  inputVideoUrl?: string | null;
  errorMessage?: string | null;
  durationSeconds?: number | null;
  language?: string | null;
  wordsCount?: number | null;
  linesCount?: number | null;
}

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_SIZE_MB = 500;
const DEFAULT_POSITION = 88; // % do topo — "embaixo"
const PREVIEW_TEXT = "EXEMPLO DA LEGENDA";

export default function CaptionsPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [videoDims, setVideoDims] = useState<{ width: number; height: number } | null>(null);
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [position, setPosition] = useState<number>(DEFAULT_POSITION);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ language?: string | null; wordsCount?: number | null; linesCount?: number | null; duration?: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "polling") return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const interval = setInterval(() => {
      if (startedAtRef.current) setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  useEffect(() => {
    if (phase !== "polling" || !jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/captions/${jobId}`);
        const data = (await res.json()) as PollResponse;
        if (cancelled) return;
        if (data.status === "COMPLETED" && data.outputVideoUrl) {
          setResultUrl(data.outputVideoUrl);
          setMeta({ language: data.language, wordsCount: data.wordsCount, linesCount: data.linesCount, duration: data.durationSeconds });
          setPhase("done");
          toast.success("Legenda pronta!");
          return;
        }
        if (data.status === "FAILED") {
          setError(data.errorMessage ?? "Falhou");
          setPhase("error");
          toast.error(data.errorMessage ?? "Falhou");
          return;
        }
        pollRef.current = setTimeout(tick, 4000);
      } catch {
        if (!cancelled) pollRef.current = setTimeout(tick, 6000);
      }
    };
    pollRef.current = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [phase, jobId]);

  // Quando o videoUrl muda, extrai dimensões + frame do 1º segundo pra preview.
  // Frame capturado via canvas pra evitar carregar o vídeo inteiro no preview.
  useEffect(() => {
    if (!videoUrl) {
      setVideoDims(null);
      setPreviewFrame(null);
      return;
    }
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    let settled = false;

    const cleanup = () => {
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
    };

    video.addEventListener("loadedmetadata", () => {
      setVideoDims({ width: video.videoWidth, height: video.videoHeight });
      // Pula pra ~1s ou 10% pra escapar de frame preto inicial
      const seekTo = Math.min(1, (video.duration || 1) * 0.1);
      try { video.currentTime = seekTo; } catch { /* ignore */ }
    });
    video.addEventListener("seeked", () => {
      if (settled) return;
      settled = true;
      try {
        const canvas = document.createElement("canvas");
        // Limita preview a 640px de largura pra não pesar
        const maxW = 640;
        const scale = Math.min(1, maxW / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          setPreviewFrame(canvas.toDataURL("image/jpeg", 0.75));
        }
      } catch (err) {
        // CORS pode bloquear canvas.toDataURL — cai pro fallback de vídeo direto
        console.warn("[captions] não conseguiu extrair frame, usando vídeo no preview:", err);
        setPreviewFrame(null);
      }
      cleanup();
    });
    video.addEventListener("error", () => {
      cleanup();
    });
    video.src = videoUrl;
    return () => {
      settled = true;
      cleanup();
    };
  }, [videoUrl]);

  const handleFileSelect = async (file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) { toast.error("Formato não suportado. Envie MP4, MOV ou WebM."); return; }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) { toast.error(`Vídeo maior que ${MAX_SIZE_MB}MB.`); return; }
    setPhase("uploading");
    setError(null);
    setUploadProgress(0);
    setVideoName(file.name);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "mp4";
      const blob = await upload(`captions-input-${Date.now()}.${ext}`, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
        clientPayload: "input_video",
        onUploadProgress: (p) => setUploadProgress(p.percentage),
      });
      setVideoUrl(blob.url);
      setPhase("idle");
      toast.success("Vídeo enviado");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro no upload";
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const handleSubmit = async () => {
    if (!videoUrl) return;
    setPhase("submitting");
    setError(null);
    setResultUrl(null);
    setMeta(null);
    setElapsedSec(0);
    startedAtRef.current = null;
    try {
      const res = await fetch("/api/captions/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, position }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao iniciar");
      setJobId(data.id);
      setPhase("polling");
      toast.info("Transcrevendo e queimando legenda...");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar";
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const handleReset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    startedAtRef.current = null;
    setPhase("idle");
    setVideoUrl(null);
    setVideoName(null);
    setVideoDims(null);
    setPreviewFrame(null);
    setPosition(DEFAULT_POSITION);
    setUploadProgress(0);
    setJobId(null);
    setResultUrl(null);
    setMeta(null);
    setError(null);
    setElapsedSec(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRemoveVideo = () => {
    setVideoUrl(null);
    setVideoName(null);
    setVideoDims(null);
    setPreviewFrame(null);
    setPosition(DEFAULT_POSITION);
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDownload = async () => {
    if (!resultUrl) return;
    setDownloading(true);
    try {
      const res = await fetch(resultUrl);
      if (!res.ok) throw new Error(`Download falhou: ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `legendado-${jobId ?? Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao baixar";
      toast.error(msg);
    } finally {
      setDownloading(false);
    }
  };

  const isLocked = phase === "uploading" || phase === "submitting" || phase === "polling";

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Subtitles className="w-6 h-6 text-violet-400" />
          Legendar Vídeo
        </h1>
        <p className="text-white/40 text-sm mt-1">
          Suba um vídeo e receba ele com legenda karaokê — palavra acende em amarelo conforme a fala. O vídeo original não é modificado, só a legenda é queimada por cima.
        </p>
      </div>

      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardContent className="p-5 space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center justify-between">
              <span>Vídeo</span>
              {videoUrl && (
                <button
                  onClick={handleRemoveVideo}
                  disabled={isLocked}
                  className="text-white/40 hover:text-white/80 text-[10px] normal-case tracking-normal flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> trocar
                </button>
              )}
            </label>

            {videoUrl ? (
              <div className="bg-white/[0.02] border border-white/[0.08] rounded-lg p-3 flex items-center gap-3">
                <div className="w-12 h-12 rounded bg-violet-500/20 flex items-center justify-center flex-shrink-0">
                  <Subtitles className="w-5 h-5 text-violet-300" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white/90 text-sm font-medium truncate">{videoName ?? "vídeo enviado"}</p>
                  <p className="text-white/40 text-xs">
                    {videoDims ? `${videoDims.width}×${videoDims.height} · pronto pra legendar` : "Pronto pra legendar"}
                  </p>
                </div>
              </div>
            ) : (
              <label
                className={cn(
                  "flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-lg border border-dashed border-white/[0.12] bg-white/[0.02] text-white/50 text-sm cursor-pointer hover:bg-white/[0.04] hover:text-white/70 transition",
                  isLocked && "opacity-50 cursor-not-allowed",
                )}
              >
                {phase === "uploading" ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
                    <span>Subindo... {Math.round(uploadProgress)}%</span>
                    <div className="w-full max-w-xs h-1 bg-white/[0.05] rounded overflow-hidden">
                      <div className="h-full bg-violet-500 transition-all duration-200" style={{ width: `${uploadProgress}%` }} />
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="w-5 h-5" />
                    <span>Selecionar vídeo (MP4, MOV, WebM · máx {MAX_SIZE_MB}MB)</span>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  disabled={isLocked}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                  }}
                />
              </label>
            )}
          </div>

          {/* Position picker — só aparece depois do upload */}
          {videoUrl && phase !== "done" && (
            <div>
              <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5"><MoveVertical className="w-3.5 h-3.5" /> Posição da legenda</span>
                <span className="text-white/30 normal-case tracking-normal">{Math.round(position)}% do topo</span>
              </label>
              <PositionPicker
                videoUrl={videoUrl}
                previewFrame={previewFrame}
                videoDims={videoDims}
                position={position}
                onPositionChange={setPosition}
                disabled={isLocked}
              />
              <div className="grid grid-cols-3 gap-2 mt-2">
                <PresetButton active={Math.abs(position - 12) < 4} onClick={() => setPosition(12)} disabled={isLocked} icon={<ArrowUp className="w-3 h-3" />} label="Topo" />
                <PresetButton active={Math.abs(position - 50) < 4} onClick={() => setPosition(50)} disabled={isLocked} icon={<MoveVertical className="w-3 h-3" />} label="Meio" />
                <PresetButton active={Math.abs(position - 88) < 4} onClick={() => setPosition(88)} disabled={isLocked} icon={<ArrowDown className="w-3 h-3" />} label="Embaixo" />
              </div>
              <p className="text-[11px] text-white/30 mt-1.5">
                Arraste o retângulo amarelo pra escolher onde a legenda vai aparecer. Os botões abaixo dão presets rápidos.
              </p>
            </div>
          )}

          {phase === "done" ? (
            <Button onClick={handleReset} variant="outline" className="w-full">
              Legendar outro vídeo
            </Button>
          ) : phase === "polling" || phase === "submitting" ? (
            <Button onClick={handleReset} variant="outline" className="w-full">
              Cancelar
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!videoUrl || isLocked}
              className="w-full bg-violet-500 hover:bg-violet-600 text-white font-semibold py-6"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Gerar legenda
            </Button>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {(phase === "submitting" || phase === "polling") && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <div className="flex-1">
                <p className="text-white/90 text-sm font-medium">Transcrevendo fala e queimando legenda...</p>
                <p className="text-white/40 text-xs">
                  {phase === "polling" && elapsedSec > 0
                    ? `${elapsedSec}s decorridos · normalmente leva 30-90s pra vídeos curtos`
                    : "Iniciando..."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "done" && resultUrl && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <video src={resultUrl} controls className="w-full rounded-lg bg-black" style={{ maxHeight: "70vh" }} />
            {meta && (
              <div className="flex flex-wrap gap-3 text-xs text-white/50">
                {meta.duration ? <span>{meta.duration.toFixed(1)}s</span> : null}
                {meta.language ? <span>idioma: {meta.language}</span> : null}
                {meta.wordsCount ? <span>{meta.wordsCount} palavras</span> : null}
                {meta.linesCount ? <span>{meta.linesCount} linhas</span> : null}
              </div>
            )}
            <Button onClick={handleDownload} disabled={downloading} className="w-full">
              {downloading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Baixando...</>
              ) : (
                <><Download className="w-4 h-4 mr-2" />Baixar MP4</>
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PresetButton({ active, onClick, disabled, icon, label }: { active: boolean; onClick: () => void; disabled?: boolean; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-3 py-2 rounded-lg border text-xs font-medium transition-all flex items-center justify-center gap-1.5",
        active
          ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
          : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface PositionPickerProps {
  videoUrl: string;
  previewFrame: string | null;
  videoDims: { width: number; height: number } | null;
  position: number;
  onPositionChange: (v: number) => void;
  disabled?: boolean;
}

// Mostra o 1º frame do vídeo (ou o vídeo direto como fallback) e um retângulo
// amarelo arrastável só no eixo Y representando onde a legenda vai cair.
function PositionPicker({ videoUrl, previewFrame, videoDims, position, onPositionChange, disabled }: PositionPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const aspect = videoDims ? videoDims.width / videoDims.height : 9 / 16;

  const updateFromPointer = useCallback((clientY: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientY - rect.top) / rect.height;
    const pct = Math.max(2, Math.min(98, rel * 100));
    onPositionChange(pct);
  }, [onPositionChange]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateFromPointer(e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current || disabled) return;
    updateFromPointer(e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // Tamanho da "linha" amarela em % da altura — proporcional ao fontSize estimado
  // (fonte ~ height/22 → linha ~5% da altura).
  const lineHeightPct = 6;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full rounded-lg overflow-hidden border border-white/[0.08] bg-black select-none",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-ns-resize",
      )}
      style={{ aspectRatio: `${aspect}`, maxHeight: 420 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {previewFrame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewFrame} alt="Frame do vídeo" className="absolute inset-0 w-full h-full object-contain pointer-events-none" draggable={false} />
      ) : (
        <video
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
      )}

      {/* Retângulo da legenda */}
      <div
        className="absolute left-2 right-2 flex items-center justify-center pointer-events-none"
        style={{
          top: `calc(${position}% - ${lineHeightPct / 2}%)`,
          height: `${lineHeightPct}%`,
        }}
      >
        <div className="px-3 py-1 rounded bg-black/60 border border-yellow-400/70 backdrop-blur-sm">
          <span
            className="text-yellow-300 font-bold tracking-wide whitespace-nowrap"
            style={{
              fontSize: "clamp(10px, 2.4cqh, 22px)",
              textShadow: "0 1px 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6)",
            }}
          >
            {PREVIEW_TEXT}
          </span>
        </div>
      </div>

      {/* Guia horizontal sutil pra ajudar no alinhamento */}
      <div
        className="absolute left-0 right-0 border-t border-yellow-400/30 pointer-events-none"
        style={{ top: `${position}%` }}
      />
    </div>
  );
}
