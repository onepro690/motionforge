"use client";

import { useEffect, useRef, useState } from "react";
import { Subtitles, Loader2, Download, Upload, X, Sparkles } from "lucide-react";
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

export default function CaptionsPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
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

  // Tick do contador de tempo enquanto processa
  useEffect(() => {
    if (phase !== "polling") return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const interval = setInterval(() => {
      if (startedAtRef.current) {
        setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Polling do status do job
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
          setMeta({
            language: data.language,
            wordsCount: data.wordsCount,
            linesCount: data.linesCount,
            duration: data.durationSeconds,
          });
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

  const handleFileSelect = async (file: File) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error("Formato não suportado. Envie MP4, MOV ou WebM.");
      return;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      toast.error(`Vídeo maior que ${MAX_SIZE_MB}MB.`);
      return;
    }

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
        body: JSON.stringify({ videoUrl }),
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
          Suba um vídeo e receba ele com legenda karaokê — palavra acende em amarelo conforme a fala. O vídeo original não é modificado em nada, só a legenda é queimada por cima.
        </p>
      </div>

      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardContent className="p-5 space-y-4">
          {/* Upload */}
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
                  <p className="text-white/40 text-xs">Pronto pra legendar</p>
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
                      <div
                        className="h-full bg-violet-500 transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
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

          {/* Botão */}
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

      {/* Status enquanto processa */}
      {(phase === "submitting" || phase === "polling") && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <div className="flex-1">
                <p className="text-white/90 text-sm font-medium">
                  Transcrevendo fala e queimando legenda...
                </p>
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

      {/* Resultado */}
      {phase === "done" && resultUrl && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <video
              src={resultUrl}
              controls
              className="w-full rounded-lg bg-black"
              style={{ maxHeight: "70vh" }}
            />
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
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Baixando...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Baixar MP4
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
