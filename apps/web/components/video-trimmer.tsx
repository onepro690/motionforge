"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { Scissors } from "lucide-react";

interface VideoTrimmerProps {
  duration: number;
  trimStart: number;
  trimEnd: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onChange: (trimStart: number, trimEnd: number) => void;
}

type DragTarget = "start" | "end" | "range" | null;

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return m > 0 ? `${m}:${sec}` : `${(s).toFixed(2)}s`;
}

export function VideoTrimmer({ duration, trimStart, trimEnd, videoRef, onChange }: VideoTrimmerProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<DragTarget>(null);
  const dragStartX = useRef(0);
  const dragStartTrim = useRef({ start: 0, end: 0 });
  const [activeDrag, setActiveDrag] = useState<DragTarget>(null);

  const endPoint = duration - trimEnd;

  // Enforce playback within the trim range: loop from trimStart to endPoint
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    // Seek to trimStart whenever trim changes
    if (vid.currentTime < trimStart || vid.currentTime > endPoint) {
      vid.currentTime = trimStart;
    }

    const onTimeUpdate = () => {
      if (!vid) return;
      if (vid.currentTime >= endPoint - 0.05) {
        vid.currentTime = trimStart;
        void vid.play().catch(() => {/* ignore */});
      }
    };

    vid.addEventListener("timeupdate", onTimeUpdate);
    return () => vid.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef, trimStart, trimEnd, endPoint]);

  const kept = duration - trimStart - trimEnd;
  const startPct = trimStart / duration;
  const endPct = trimEnd / duration;

  // Seek video — clamped to the active trim range
  const seekTo = useCallback((sec: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.currentTime = Math.max(trimStart, Math.min(endPoint, sec));
  }, [videoRef, trimStart, endPoint]);

  const pctFromEvent = useCallback((clientX: number): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent, target: DragTarget) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = target;
    dragStartX.current = e.clientX;
    dragStartTrim.current = { start: trimStart, end: trimEnd };
    setActiveDrag(target);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [trimStart, trimEnd]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const bar = barRef.current;
    if (!bar) return;

    const rect = bar.getBoundingClientRect();
    const dx = (e.clientX - dragStartX.current) / rect.width;
    const MIN_KEPT = 0.3; // minimum 0.3s

    if (dragging.current === "start") {
      const newStart = Math.max(0, Math.min(
        dragStartTrim.current.start + dx * duration,
        duration - dragStartTrim.current.end - MIN_KEPT
      ));
      onChange(+newStart.toFixed(3), trimEnd);
      seekTo(newStart);
    } else if (dragging.current === "end") {
      const newEnd = Math.max(0, Math.min(
        dragStartTrim.current.end - dx * duration,
        duration - dragStartTrim.current.start - MIN_KEPT
      ));
      onChange(trimStart, +newEnd.toFixed(3));
      seekTo(duration - newEnd);
    } else if (dragging.current === "range") {
      const dSec = dx * duration;
      const newStart = Math.max(0, Math.min(dragStartTrim.current.start + dSec, duration - kept));
      const newEnd = Math.max(0, duration - newStart - kept);
      onChange(+newStart.toFixed(3), +newEnd.toFixed(3));
      seekTo(newStart);
    }
  }, [duration, trimStart, trimEnd, kept, onChange, seekTo]);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
    setActiveDrag(null);
  }, []);

  // Click on the timeline to seek (clamped to trim range)
  const onBarClick = useCallback((e: React.MouseEvent) => {
    if (activeDrag) return;
    const pct = pctFromEvent(e.clientX);
    seekTo(pct * duration);
  }, [activeDrag, pctFromEvent, seekTo, duration]);

  // Global pointer up in case pointer leaves the element
  useEffect(() => {
    const up = () => { dragging.current = null; setActiveDrag(null); };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  return (
    <div className="space-y-2 p-2.5 bg-white/[0.03] rounded-lg border border-white/[0.06]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Scissors className="w-3 h-3 text-white/40" />
          <span className="text-xs text-white/50">Cortar clipe</span>
        </div>
        <span className="text-xs text-white/30">
          {fmt(trimStart)} — {fmt(duration - trimEnd)}
          <span className="ml-1.5 text-violet-300/70">({fmt(kept)} restante)</span>
        </span>
      </div>

      {/* Timeline bar */}
      <div
        ref={barRef}
        className="relative h-10 rounded-lg overflow-visible cursor-crosshair select-none"
        style={{ background: "rgba(255,255,255,0.04)" }}
        onClick={onBarClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Trimmed-off zones (dark overlay) */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-lg"
          style={{ width: `${startPct * 100}%`, background: "rgba(0,0,0,0.55)" }}
        />
        <div
          className="absolute inset-y-0 right-0 rounded-r-lg"
          style={{ width: `${endPct * 100}%`, background: "rgba(0,0,0,0.55)" }}
        />

        {/* Kept zone (highlighted) — drag to shift both handles together */}
        <div
          className={`absolute inset-y-0 border-t-2 border-b-2 ${activeDrag === "range" ? "border-violet-300 cursor-grabbing" : "border-violet-500/70 cursor-grab"}`}
          style={{
            left: `${startPct * 100}%`,
            right: `${endPct * 100}%`,
            background: "rgba(139,92,246,0.10)",
          }}
          onPointerDown={(e) => onPointerDown(e, "range")}
        />

        {/* Tick marks (every second) */}
        {Array.from({ length: Math.floor(duration) + 1 }, (_, i) => i).map((sec) => (
          <div
            key={sec}
            className="absolute top-0 bottom-0 w-px"
            style={{
              left: `${(sec / duration) * 100}%`,
              background: "rgba(255,255,255,0.08)",
              pointerEvents: "none",
            }}
          >
            {sec > 0 && sec < duration && (
              <span className="absolute top-0.5 left-0.5 text-[9px] text-white/20 leading-none">{sec}s</span>
            )}
          </div>
        ))}

        {/* Start handle */}
        <div
          className={`absolute inset-y-0 w-4 -ml-2 flex items-center justify-center cursor-ew-resize z-10 group ${activeDrag === "start" ? "opacity-100" : ""}`}
          style={{ left: `${startPct * 100}%` }}
          onPointerDown={(e) => onPointerDown(e, "start")}
        >
          <div className={`w-3 h-full rounded-l flex flex-col items-center justify-center gap-0.5 transition-colors ${activeDrag === "start" ? "bg-violet-400" : "bg-violet-500 group-hover:bg-violet-400"}`}>
            <div className="w-0.5 h-3 bg-white/60 rounded-full" />
            <div className="w-0.5 h-2 bg-white/40 rounded-full" />
          </div>
          {/* Tooltip */}
          <div className={`absolute -top-7 left-1/2 -translate-x-1/2 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none transition-opacity ${activeDrag === "start" ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {fmt(trimStart)}
          </div>
        </div>

        {/* End handle */}
        <div
          className={`absolute inset-y-0 w-4 -mr-2 flex items-center justify-center cursor-ew-resize z-10 group ${activeDrag === "end" ? "opacity-100" : ""}`}
          style={{ right: `${endPct * 100}%` }}
          onPointerDown={(e) => onPointerDown(e, "end")}
        >
          <div className={`w-3 h-full rounded-r flex flex-col items-center justify-center gap-0.5 transition-colors ${activeDrag === "end" ? "bg-violet-400" : "bg-violet-500 group-hover:bg-violet-400"}`}>
            <div className="w-0.5 h-3 bg-white/60 rounded-full" />
            <div className="w-0.5 h-2 bg-white/40 rounded-full" />
          </div>
          {/* Tooltip */}
          <div className={`absolute -top-7 right-1/2 translate-x-1/2 bg-black/80 text-white text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap pointer-events-none transition-opacity ${activeDrag === "end" ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {fmt(duration - trimEnd)}
          </div>
        </div>
      </div>

      {/* Fine-tune inputs */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-[10px] text-white/30 w-10 flex-shrink-0">Início</span>
          <input
            type="number" min={0} max={+(duration - trimEnd - 0.3).toFixed(3)} step={0.05}
            value={trimStart.toFixed(2)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(+e.target.value, duration - trimEnd - 0.3));
              onChange(+v.toFixed(3), trimEnd);
            }}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-violet-500/50"
          />
          <span className="text-[10px] text-white/25">s</span>
        </div>
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-[10px] text-white/30 w-10 flex-shrink-0">Fim</span>
          <input
            type="number" min={0} max={+(duration - trimStart - 0.3).toFixed(3)} step={0.05}
            value={trimEnd.toFixed(2)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(+e.target.value, duration - trimStart - 0.3));
              onChange(trimStart, +v.toFixed(3));
            }}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-violet-500/50"
          />
          <span className="text-[10px] text-white/25">s</span>
        </div>
        {(trimStart > 0 || trimEnd > 0) && (
          <button
            onClick={() => onChange(0, 0)}
            className="text-[10px] text-white/30 hover:text-white/60 underline flex-shrink-0"
          >
            Resetar
          </button>
        )}
      </div>
    </div>
  );
}
