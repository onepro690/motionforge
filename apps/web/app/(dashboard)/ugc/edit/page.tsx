"use client";
import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Scissors, Loader2, Play, Pause, SkipBack, SkipForward,
  Trash2, Save, ArrowLeft, Undo2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

interface Take {
  id: string;
  takeIndex: number;
  status: string;
  videoUrl: string | null;
  script: string | null;
  durationSeconds: number | null;
}

interface VideoDetail {
  id: string;
  title: string | null;
  status: string;
  finalVideoUrl: string | null;
  durationSeconds: number | null;
  audioUrl: string | null;
  product: { name: string };
  takes: Take[];
}

interface CutRegion {
  id: string;
  takeIndex: number;
  start: number;
  end: number;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function TakeTimeline({
  take, duration, cuts, onAddCut, onRemoveCut, isActive, onSeek, currentTime,
}: {
  take: Take;
  duration: number;
  cuts: CutRegion[];
  onAddCut: (takeIndex: number, start: number, end: number) => void;
  onRemoveCut: (cutId: string) => void;
  isActive: boolean;
  onSeek: (takeIndex: number, time: number) => void;
  currentTime: number;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [selectStart, setSelectStart] = useState<number | null>(null);
  const [selectEnd, setSelectEnd] = useState<number | null>(null);

  const getTimeFromX = (clientX: number): number => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${isActive ? "border-violet-500/40 bg-violet-500/5" : "border-white/[0.06] bg-white/[0.02]"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white/60">Take {take.takeIndex + 1}</span>
          <span className="text-xs text-white/30">{formatTime(duration)}</span>
          {cuts.length > 0 && (
            <span className="text-xs text-red-400/70">{cuts.length} corte{cuts.length > 1 ? "s" : ""}</span>
          )}
        </div>
        {take.script && (
          <p className="text-xs text-white/30 truncate max-w-[300px]" title={take.script}>{take.script}</p>
        )}
      </div>

      <div
        ref={timelineRef}
        className="relative h-10 bg-white/5 rounded cursor-crosshair select-none"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          setSelectStart(getTimeFromX(e.clientX));
          setSelectEnd(null);
        }}
        onMouseMove={(e) => {
          if (selectStart !== null) setSelectEnd(getTimeFromX(e.clientX));
        }}
        onMouseUp={(e) => {
          if (selectStart !== null) {
            const end = getTimeFromX(e.clientX);
            const s = Math.min(selectStart, end);
            const en = Math.max(selectStart, end);
            if (en - s > 0.2) {
              onAddCut(take.takeIndex, s, en);
            } else {
              onSeek(take.takeIndex, s);
            }
          }
          setSelectStart(null);
          setSelectEnd(null);
        }}
        onMouseLeave={() => { setSelectStart(null); setSelectEnd(null); }}
      >
        <div className="absolute inset-0 rounded overflow-hidden">
          <div className="w-full h-full bg-emerald-500/10" />
        </div>

        {/* Cut regions */}
        {cuts.map(cut => (
          <div
            key={cut.id}
            className="absolute top-0 bottom-0 bg-red-500/30 border-x border-red-500/50 group"
            style={{ left: `${(cut.start / duration) * 100}%`, width: `${((cut.end - cut.start) / duration) * 100}%` }}
          >
            <button
              className="absolute top-0.5 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-red-600 rounded px-1 py-0.5"
              onClick={(e) => { e.stopPropagation(); onRemoveCut(cut.id); }}
            >
              <Trash2 className="w-2.5 h-2.5 text-white" />
            </button>
            <span className="absolute bottom-0.5 left-1 text-[9px] text-red-300/80">{formatTime(cut.start)}</span>
            <span className="absolute bottom-0.5 right-1 text-[9px] text-red-300/80">{formatTime(cut.end)}</span>
          </div>
        ))}

        {/* Selection preview */}
        {selectStart !== null && selectEnd !== null && Math.abs(selectEnd - selectStart) > 0.1 && (
          <div
            className="absolute top-0 bottom-0 bg-red-500/20 border-x border-red-500/40"
            style={{
              left: `${(Math.min(selectStart, selectEnd) / duration) * 100}%`,
              width: `${(Math.abs(selectEnd - selectStart) / duration) * 100}%`,
            }}
          />
        )}

        {/* Playhead */}
        {isActive && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white/80 z-10 pointer-events-none"
            style={{ left: `${(currentTime / duration) * 100}%` }}
          >
            <div className="w-2 h-2 bg-white rounded-full -translate-x-[3px] -top-1 absolute" />
          </div>
        )}
      </div>
    </div>
  );
}

function EditPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const videoId = searchParams.get("id");

  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cuts, setCuts] = useState<CutRegion[]>([]);
  const [takeDurations, setTakeDurations] = useState<Record<number, number>>({});
  const [activeTakeIndex, setActiveTakeIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const videoRefs = useRef<Record<number, HTMLVideoElement>>({});

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

  const handleTakeLoaded = (takeIndex: number, el: HTMLVideoElement) => {
    videoRefs.current[takeIndex] = el;
    const onMeta = () => {
      if (el.duration && !isNaN(el.duration)) {
        setTakeDurations(prev => ({ ...prev, [takeIndex]: el.duration }));
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    if (el.duration && !isNaN(el.duration)) onMeta();
  };

  useEffect(() => {
    const el = videoRefs.current[activeTakeIndex];
    if (!el) return;
    const handler = () => setCurrentTime(el.currentTime);
    el.addEventListener("timeupdate", handler);
    return () => el.removeEventListener("timeupdate", handler);
  }, [activeTakeIndex, takeDurations]);

  const addCut = (takeIndex: number, start: number, end: number) => {
    setCuts(prev => [...prev, {
      id: `cut-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      takeIndex,
      start: Math.max(0, start),
      end: Math.min(end, takeDurations[takeIndex] ?? end),
    }]);
  };

  const handleSave = async () => {
    if (!video) return;
    const completedTakes = video.takes.filter(t => t.status === "COMPLETED" && t.videoUrl);
    const keepSegments: { takeIndex: number; start: number; end: number }[] = [];

    for (const take of completedTakes) {
      const dur = takeDurations[take.takeIndex] ?? take.durationSeconds ?? 8;
      const takeCuts = cuts.filter(c => c.takeIndex === take.takeIndex).sort((a, b) => a.start - b.start);
      if (takeCuts.length === 0) {
        keepSegments.push({ takeIndex: take.takeIndex, start: 0, end: dur });
        continue;
      }
      let pos = 0;
      for (const cut of takeCuts) {
        if (cut.start > pos) keepSegments.push({ takeIndex: take.takeIndex, start: pos, end: cut.start });
        pos = cut.end;
      }
      if (pos < dur) keepSegments.push({ takeIndex: take.takeIndex, start: pos, end: dur });
    }

    if (keepSegments.length === 0) { toast.error("Nenhum segmento para manter!"); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/ugc/generations/${video.id}/trim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: keepSegments }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Video cortado com sucesso!");
        await load();
        setCuts([]);
      } else {
        toast.error(json.error ?? "Erro ao cortar");
      }
    } finally {
      setSaving(false);
    }
  };

  if (!videoId) return <div className="flex items-center justify-center py-16"><p className="text-white/40 text-sm">Nenhum video selecionado</p></div>;
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>;
  if (!video) return <div className="flex items-center justify-center py-16"><p className="text-white/40 text-sm">Video nao encontrado</p></div>;

  const completedTakes = video.takes.filter(t => t.status === "COMPLETED" && t.videoUrl);
  const totalCutDuration = cuts.reduce((acc, c) => acc + (c.end - c.start), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" className="border-white/10 text-white/60 hover:text-white" onClick={() => router.push(`/ugc/review?id=${video.id}`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <Scissors className="w-4 h-4 text-violet-400" />
              Editar Video
            </h1>
            <p className="text-xs text-white/40">{video.product.name} - {video.title ?? video.id.slice(-8)}</p>
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

      <div className="flex gap-4 text-xs text-white/40">
        <span>{completedTakes.length} takes</span>
        <span>{video.durationSeconds ? `${Math.round(video.durationSeconds)}s total` : ""}</span>
        {cuts.length > 0 && (
          <span className="text-red-400">{cuts.length} corte{cuts.length > 1 ? "s" : ""} (-{totalCutDuration.toFixed(1)}s)</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <div className="space-y-3">
          <Card className="bg-white/[0.02] border-white/[0.06] p-4">
            <p className="text-xs text-white/30 mb-3">
              Arraste na timeline para selecionar trechos para cortar (vermelho = removido).
            </p>
            <div className="space-y-2">
              {completedTakes.map(take => (
                <TakeTimeline
                  key={take.id}
                  take={take}
                  duration={takeDurations[take.takeIndex] ?? take.durationSeconds ?? 8}
                  cuts={cuts.filter(c => c.takeIndex === take.takeIndex)}
                  onAddCut={addCut}
                  onRemoveCut={(cutId) => setCuts(prev => prev.filter(c => c.id !== cutId))}
                  isActive={activeTakeIndex === take.takeIndex}
                  onSeek={(ti, time) => {
                    setActiveTakeIndex(ti);
                    const el = videoRefs.current[ti];
                    if (el) { el.currentTime = time; setCurrentTime(time); }
                  }}
                  currentTime={activeTakeIndex === take.takeIndex ? currentTime : 0}
                />
              ))}
            </div>
          </Card>

          {cuts.length > 0 && (
            <Card className="bg-white/[0.02] border-white/[0.06] p-4">
              <p className="text-xs text-white/30 uppercase tracking-wide mb-2">Cortes</p>
              <div className="space-y-1">
                {cuts.map(cut => (
                  <div key={cut.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded bg-red-500/5 border border-red-500/10">
                    <div className="flex items-center gap-2">
                      <span className="text-white/50">Take {cut.takeIndex + 1}</span>
                      <span className="text-red-400">{formatTime(cut.start)} - {formatTime(cut.end)}</span>
                      <span className="text-white/30">({(cut.end - cut.start).toFixed(1)}s)</span>
                    </div>
                    <button onClick={() => setCuts(prev => prev.filter(c => c.id !== cut.id))} className="text-red-400/60 hover:text-red-400">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-3">
          <Card className="bg-black border-white/[0.06] overflow-hidden">
            <div className="aspect-[9/16] relative">
              {completedTakes.map(take => (
                <video
                  key={take.id}
                  src={take.videoUrl!}
                  className={`absolute inset-0 w-full h-full object-cover ${activeTakeIndex === take.takeIndex ? "block" : "hidden"}`}
                  ref={(el) => { if (el) handleTakeLoaded(take.takeIndex, el); }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  playsInline
                />
              ))}
            </div>
            <div className="flex items-center justify-between px-3 py-2 bg-black/80">
              <div className="flex items-center gap-1">
                <button className="p-1 text-white/60 hover:text-white" onClick={() => { const el = videoRefs.current[activeTakeIndex]; if (el) el.currentTime = Math.max(0, el.currentTime - 2); }}>
                  <SkipBack className="w-3.5 h-3.5" />
                </button>
                <button className="p-1.5 text-white hover:text-violet-300" onClick={() => {
                  const el = videoRefs.current[activeTakeIndex];
                  if (!el) return;
                  if (playing) el.pause(); else el.play();
                  setPlaying(!playing);
                }}>
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <button className="p-1 text-white/60 hover:text-white" onClick={() => { const el = videoRefs.current[activeTakeIndex]; if (el) el.currentTime = Math.min(el.duration, el.currentTime + 2); }}>
                  <SkipForward className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className="text-xs text-white/40">Take {activeTakeIndex + 1} - {formatTime(currentTime)}</span>
            </div>
          </Card>

          <div className="flex gap-1 flex-wrap">
            {completedTakes.map(take => (
              <button
                key={take.id}
                onClick={() => {
                  setActiveTakeIndex(take.takeIndex);
                  setPlaying(false);
                  Object.values(videoRefs.current).forEach(v => v.pause());
                }}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  activeTakeIndex === take.takeIndex
                    ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                    : "text-white/40 hover:text-white bg-white/[0.03] border border-transparent"
                }`}
              >
                Take {take.takeIndex + 1}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function EditPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>}>
      <EditPageContent />
    </Suspense>
  );
}
