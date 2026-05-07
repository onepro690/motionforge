"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Loader2, Download, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Phase = "idle" | "submitting" | "polling" | "done" | "error";

interface SegmentSummary {
  index: number;
  text: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  error?: string | null;
}

interface PollResponse {
  id: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  finalVideoUrl?: string | null;
  errorMessage?: string | null;
  narrationDurationSeconds?: number;
  segments?: SegmentSummary[];
  progress?: { completed: number; total: number };
}

const COPY_EXAMPLES = [
  "Você acorda cedo. Toma seu café. Mas a vida continua igual. E se a sua próxima decisão mudasse tudo? Conheça o caminho que milhares já trilharam para sair do comum.",
];

export default function NarratorPage() {
  const [copy, setCopy] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [narrationDuration, setNarrationDuration] = useState<number | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Polling loop
  useEffect(() => {
    if (phase !== "polling" || !jobId) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/narrator/${jobId}`);
        const data = (await res.json()) as PollResponse;
        if (cancelled) return;

        if (data.segments) setSegments(data.segments);
        if (data.progress) setProgress(data.progress);
        if (data.narrationDurationSeconds) setNarrationDuration(data.narrationDurationSeconds);

        if (data.status === "COMPLETED" && data.finalVideoUrl) {
          setFinalUrl(data.finalVideoUrl);
          setPhase("done");
          toast.success("Vídeo pronto!");
          return;
        }
        if (data.status === "FAILED") {
          setError(data.errorMessage ?? "Falhou");
          setPhase("error");
          toast.error(data.errorMessage ?? "Falhou");
          return;
        }
        // continua polling
        pollRef.current = setTimeout(tick, 8000);
      } catch (err) {
        if (cancelled) return;
        // erro transiente — tenta de novo em 10s
        pollRef.current = setTimeout(tick, 10000);
      }
    };

    pollRef.current = setTimeout(tick, 4000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [phase, jobId]);

  const handleSubmit = async () => {
    const trimmed = copy.trim();
    if (trimmed.length < 20) {
      toast.error("Escreva uma copy com pelo menos 20 caracteres");
      return;
    }
    if (trimmed.length > 4000) {
      toast.error("Copy muito longa (limite 4000 caracteres)");
      return;
    }
    setPhase("submitting");
    setError(null);
    setFinalUrl(null);
    setSegments([]);
    setProgress(null);
    setNarrationDuration(null);
    try {
      const res = await fetch("/api/narrator/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ copy: trimmed, gender }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao iniciar geração");
      setJobId(data.id);
      setNarrationDuration(data.narrationDurationSeconds ?? null);
      setPhase("polling");
      toast.info(`Narração de ${Math.round(data.narrationDurationSeconds ?? 0)}s. ${data.takeCount} takes em geração.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar";
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const handleReset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setPhase("idle");
    setJobId(null);
    setFinalUrl(null);
    setError(null);
    setSegments([]);
    setProgress(null);
    setNarrationDuration(null);
  };

  const isLocked = phase === "submitting" || phase === "polling";
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? segments.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Mic className="w-6 h-6 text-violet-400" />
          Narrador IA
        </h1>
        <p className="text-white/40 text-sm mt-1">
          Cole sua copy. Escolha a voz. Receba um vídeo com B-roll cinematográfico narrado por cima.
        </p>
      </div>

      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardContent className="p-5 space-y-4">
          {/* Voz */}
          <div>
            <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 block">
              Voz do narrador
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setGender("male")}
                disabled={isLocked}
                className={cn(
                  "px-4 py-3 rounded-lg border text-sm font-medium transition-all",
                  gender === "male"
                    ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                    : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                  isLocked && "opacity-50 cursor-not-allowed"
                )}
              >
                Homem · Onyx
              </button>
              <button
                onClick={() => setGender("female")}
                disabled={isLocked}
                className={cn(
                  "px-4 py-3 rounded-lg border text-sm font-medium transition-all",
                  gender === "female"
                    ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                    : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                  isLocked && "opacity-50 cursor-not-allowed"
                )}
              >
                Mulher · Nova
              </button>
            </div>
          </div>

          {/* Copy */}
          <div>
            <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center justify-between">
              <span>Copy falada</span>
              <span className="text-white/30 normal-case tracking-normal">
                {copy.length} chars · ≈{Math.round(copy.split(/\s+/).filter(Boolean).length / 2.8)}s narrado
              </span>
            </label>
            <textarea
              value={copy}
              onChange={(e) => setCopy(e.target.value)}
              disabled={isLocked}
              rows={8}
              placeholder={COPY_EXAMPLES[0]}
              className="w-full bg-white/[0.02] border border-white/[0.08] rounded-lg px-4 py-3 text-white placeholder-white/20 text-sm leading-relaxed focus:outline-none focus:border-violet-500/40 resize-none disabled:opacity-60"
            />
            <p className="text-xs text-white/30 mt-1.5">
              A cada 8s de narração geramos 1 take Veo 3 Fast. A copy é sempre narrada por inteiro.
            </p>
          </div>

          {/* Botão */}
          {phase === "idle" || phase === "error" ? (
            <Button
              onClick={handleSubmit}
              disabled={copy.trim().length < 20}
              className="w-full bg-violet-500 hover:bg-violet-600 text-white font-semibold py-6"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Gerar vídeo narrado
            </Button>
          ) : (
            <Button onClick={handleReset} variant="outline" className="w-full">
              {phase === "done" ? "Gerar outro" : "Cancelar"}
            </Button>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Status */}
      {(phase === "submitting" || phase === "polling") && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <div className="flex-1">
                <p className="text-white/90 text-sm font-medium">
                  {phase === "submitting"
                    ? "Gerando narração e disparando takes..."
                    : `${completed}/${total} takes prontos · ${pct}%`}
                </p>
                {narrationDuration !== null && (
                  <p className="text-white/40 text-xs">Narração de {narrationDuration.toFixed(1)}s</p>
                )}
              </div>
            </div>
            {total > 0 && (
              <div className="h-1 bg-white/[0.05] rounded overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            {segments.length > 0 && (
              <div className="space-y-1.5 mt-3">
                {segments.map((s) => (
                  <div key={s.index} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full mt-1 flex-shrink-0",
                        s.status === "COMPLETED" && "bg-emerald-400",
                        s.status === "PROCESSING" && "bg-violet-400 animate-pulse",
                        s.status === "FAILED" && "bg-red-400"
                      )}
                    />
                    <span className="text-white/50 line-clamp-2">{s.text}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Resultado */}
      {phase === "done" && finalUrl && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <video
              src={finalUrl}
              controls
              className="w-full rounded-lg bg-black"
              style={{ aspectRatio: "9/16", maxHeight: "70vh" }}
            />
            <div className="flex gap-2">
              <Button asChild className="flex-1">
                <a href={finalUrl} download={`narrator-${jobId}.mp4`} target="_blank" rel="noopener noreferrer">
                  <Download className="w-4 h-4 mr-2" />
                  Baixar MP4
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
