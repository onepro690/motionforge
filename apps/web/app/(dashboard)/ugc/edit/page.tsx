"use client";
import { useEffect, useState, useCallback, useRef, Suspense, Component, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Scissors, Loader2, Play, Pause, Trash2, Save, ArrowLeft, Undo2, SkipBack, SkipForward
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

class EditErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    console.error("[ugc/edit] render error:", err, info);
  }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6 max-w-2xl mx-auto space-y-3">
          <h2 className="text-lg font-bold text-red-400">Erro no editor</h2>
          <pre className="text-xs text-white/70 bg-black/40 p-3 rounded border border-red-500/20 whitespace-pre-wrap overflow-auto max-h-[60vh]">
            {this.state.err.message}
            {"\n\n"}
            {this.state.err.stack}
          </pre>
          <button className="text-xs text-violet-400 underline" onClick={() => this.setState({ err: null })}>Tentar novamente</button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface VideoDetail {
  id: string;
  title: string | null;
  status: string;
  finalVideoUrl: string | null;
  durationSeconds: number | null;
  product: { name: string };
}

interface CutRegion {
  id: string;
  start: number;
  end: number;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function EditPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const videoId = searchParams.get("id");

  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cuts, setCuts] = useState<CutRegion[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectStart, setSelectStart] = useState<number | null>(null);
  const [selectEnd, setSelectEnd] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const seekbarRef = useRef<HTMLDivElement | null>(null);
  const cutsRef = useRef<CutRegion[]>([]);
  useEffect(() => { cutsRef.current = cuts; }, [cuts]);

  const load = useCallback(async () => {
    if (!videoId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/ugc/generations/${videoId}`);
      if (res.ok) setVideo(await res.json());
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => { load(); }, [load]);

  const getTimeFromX = useCallback((clientX: number, bar?: HTMLDivElement | null) => {
    const el = bar ?? timelineRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  // Skip over cut regions during playback.
  const handleTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    const t = el.currentTime;
    for (const c of cutsRef.current) {
      if (t >= c.start - 0.02 && t < c.end) {
        el.currentTime = Math.min(duration || c.end, c.end + 0.01);
        setCurrentTime(el.currentTime);
        return;
      }
    }
    setCurrentTime(t);
  };

  const handleVideoLoaded = () => {
    const el = videoRef.current;
    if (!el || !el.duration || isNaN(el.duration)) return;
    setDuration(prev => (prev === el.duration ? prev : el.duration));
  };

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play(); else el.pause();
  };

  const seekRelative = (delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(duration, el.currentTime + delta));
  };

  const addCut = (start: number, end: number) => {
    const s = Math.max(0, Math.min(start, duration));
    const e = Math.max(0, Math.min(end, duration));
    if (Math.abs(e - s) < 0.2) return;
    setCuts(prev => [...prev, {
      id: `cut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      start: Math.min(s, e),
      end: Math.max(s, e),
    }]);
  };

  const removeCut = (id: string) => setCuts(prev => prev.filter(c => c.id !== id));

  const handleSave = async () => {
    if (!video || cuts.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/ugc/generations/${video.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cuts: cuts.map(c => ({ start: c.start, end: c.end })),
        }),
      });
      let json: { error?: string; finalVideoUrl?: string; durationSeconds?: number } = {};
      try { json = await res.json(); } catch { /* non-json */ }
      if (res.ok) {
        toast.success("Vídeo cortado com sucesso!");
        setCuts([]);
        await load();
      } else {
        toast.error(json.error ?? `Erro ao cortar (HTTP ${res.status})`);
      }
    } catch (err) {
      toast.error(`Falhou: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!videoId) return <div className="flex items-center justify-center py-16"><p className="text-white/40 text-sm">Nenhum vídeo selecionado</p></div>;
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>;
  if (!video) return <div className="flex items-center justify-center py-16"><p className="text-white/40 text-sm">Vídeo não encontrado</p></div>;
  if (!video.finalVideoUrl) {
    return (
      <div className="space-y-3 py-16 flex flex-col items-center justify-center">
        <p className="text-white/40 text-sm">Este vídeo ainda não foi finalizado.</p>
        <Button size="sm" variant="outline" className="border-white/10 text-white/60 hover:text-white" onClick={() => router.push(`/ugc/review?id=${video.id}`)}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Voltar
        </Button>
      </div>
    );
  }

  const totalCutDuration = cuts.reduce((acc, c) => acc + (c.end - c.start), 0);
  const pct = (t: number) => duration > 0 ? (t / duration) * 100 : 0;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" className="border-white/10 text-white/60 hover:text-white" onClick={() => router.push(`/ugc/review?id=${video.id}`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Scissors className="w-4 h-4 text-violet-400" />
              Editar Vídeo
            </h1>
            <p className="text-xs text-white/40">{video.product.name} — {video.title ?? video.id.slice(-8)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {cuts.length > 0 && (
            <Button size="sm" variant="outline" className="border-white/10 text-white/60 hover:text-white" onClick={() => setCuts([])}>
              <Undo2 className="w-3.5 h-3.5 mr-1.5" /> Limpar
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || cuts.length === 0} className="bg-violet-600 hover:bg-violet-700 text-white">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Save className="w-4 h-4 mr-1.5" />}
            Salvar Cortes
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <Card className="bg-black border-white/[0.06] overflow-hidden">
          <div className="aspect-[9/16] relative">
            <video
              ref={videoRef}
              src={video.finalVideoUrl}
              className="absolute inset-0 w-full h-full object-contain"
              preload="metadata"
              onLoadedMetadata={handleVideoLoaded}
              onDurationChange={handleVideoLoaded}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              playsInline
              controls={false}
            />
          </div>
          <div
            ref={seekbarRef}
            className="relative h-2.5 bg-white/10 cursor-pointer group/seek touch-none"
            onPointerDown={(e) => {
              if (e.button !== 0 || duration <= 0) return;
              e.preventDefault();
              const el = videoRef.current;
              if (!el) return;
              const seek = (cx: number) => {
                const t = getTimeFromX(cx, seekbarRef.current);
                el.currentTime = t;
                setCurrentTime(t);
              };
              seek(e.clientX);
              const onMove = (ev: PointerEvent) => seek(ev.clientX);
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp);
            }}
          >
            <div className="absolute inset-y-0 left-0 bg-violet-500/80" style={{ width: `${pct(currentTime)}%` }} />
            {cuts.map(cut => (
              <div
                key={cut.id}
                className="absolute inset-y-0 bg-red-500/60"
                style={{ left: `${pct(cut.start)}%`, width: `${pct(cut.end - cut.start)}%` }}
              />
            ))}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover/seek:opacity-100 transition-opacity pointer-events-none"
              style={{ left: `calc(${pct(currentTime)}% - 6px)` }}
            />
          </div>
          <div className="flex items-center justify-between px-3 py-2 bg-black/80">
            <div className="flex items-center gap-1">
              <button className="p-1 text-white/60 hover:text-white" onClick={() => seekRelative(-2)} aria-label="Voltar 2s">
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button className="p-1.5 text-white hover:text-violet-300" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <button className="p-1 text-white/60 hover:text-white" onClick={() => seekRelative(2)} aria-label="Avançar 2s">
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>
            <span className="text-xs text-white/40 tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>
          </div>
        </Card>

        <div className="space-y-3">
          <Card className="bg-white/[0.02] border-white/[0.06] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/40">
                Arraste na barra abaixo para marcar o trecho a <span className="text-red-400">cortar</span>. Clique para pular para um ponto.
              </p>
              <div className="flex gap-3 text-xs text-white/40 tabular-nums">
                <span>{formatTime(duration)} total</span>
                {cuts.length > 0 && <span className="text-red-400">−{totalCutDuration.toFixed(1)}s</span>}
                <span className="text-emerald-400">= {formatTime(Math.max(0, duration - totalCutDuration))}</span>
              </div>
            </div>

            <div
              ref={timelineRef}
              className="relative h-16 bg-white/5 rounded cursor-crosshair select-none touch-none"
              onPointerDown={(e) => {
                if (e.button !== 0 || duration <= 0) return;
                e.preventDefault();
                const startTime = getTimeFromX(e.clientX);
                setSelectStart(startTime);
                setSelectEnd(startTime);
                const onMove = (ev: PointerEvent) => {
                  const t = getTimeFromX(ev.clientX);
                  setSelectEnd(t);
                  const el = videoRef.current;
                  if (el) el.currentTime = t;
                };
                const onUp = (ev: PointerEvent) => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  const end = getTimeFromX(ev.clientX);
                  const s = Math.min(startTime, end);
                  const en = Math.max(startTime, end);
                  if (en - s > 0.2) {
                    addCut(s, en);
                  } else {
                    const el = videoRef.current;
                    if (el) el.currentTime = s;
                  }
                  setSelectStart(null);
                  setSelectEnd(null);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
            >
              <div className="absolute inset-0 rounded bg-emerald-500/10" />

              {cuts.map(cut => (
                <div
                  key={cut.id}
                  className="absolute top-0 bottom-0 bg-red-500/30 border-x border-red-500/60 group"
                  style={{ left: `${pct(cut.start)}%`, width: `${pct(cut.end - cut.start)}%` }}
                >
                  <button
                    className="absolute top-1 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 hover:bg-red-500 rounded px-1.5 py-0.5"
                    onClick={(e) => { e.stopPropagation(); removeCut(cut.id); }}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="Remover corte"
                  >
                    <Trash2 className="w-3 h-3 text-white" />
                  </button>
                  <span className="absolute bottom-0.5 left-1 text-[10px] text-red-200 tabular-nums">{formatTime(cut.start)}</span>
                  <span className="absolute bottom-0.5 right-1 text-[10px] text-red-200 tabular-nums">{formatTime(cut.end)}</span>
                </div>
              ))}

              {selectStart !== null && selectEnd !== null && Math.abs(selectEnd - selectStart) > 0.05 && (
                <div
                  className="absolute top-0 bottom-0 bg-red-500/20 border-x border-red-500/40 pointer-events-none"
                  style={{
                    left: `${pct(Math.min(selectStart, selectEnd))}%`,
                    width: `${pct(Math.abs(selectEnd - selectStart))}%`,
                  }}
                />
              )}

              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white/90 pointer-events-none z-10"
                style={{ left: `${pct(currentTime)}%` }}
              >
                <div className="w-2.5 h-2.5 bg-white rounded-full -translate-x-[4px] -top-1 absolute" />
              </div>
            </div>
          </Card>

          {cuts.length > 0 && (
            <Card className="bg-white/[0.02] border-white/[0.06] p-4">
              <p className="text-xs text-white/30 uppercase tracking-wide mb-2">Cortes</p>
              <div className="space-y-1">
                {cuts.sort((a, b) => a.start - b.start).map(cut => (
                  <div key={cut.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-red-500/5 border border-red-500/10">
                    <div className="flex items-center gap-2 tabular-nums">
                      <span className="text-red-400">{formatTime(cut.start)} → {formatTime(cut.end)}</span>
                      <span className="text-white/30">({(cut.end - cut.start).toFixed(1)}s)</span>
                    </div>
                    <button onClick={() => removeCut(cut.id)} className="text-red-400/60 hover:text-red-400" aria-label="Remover corte">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EditPage() {
  return (
    <EditErrorBoundary>
      <Suspense fallback={<div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>}>
        <EditPageContent />
      </Suspense>
    </EditErrorBoundary>
  );
}
