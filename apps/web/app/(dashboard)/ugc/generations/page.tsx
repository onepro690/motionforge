"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Video, Loader2, ChevronLeft, ChevronRight, Play, Download,
  Eye, Clock, CheckCircle, XCircle, RotateCcw, AlertCircle, Zap, Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DownloadButton } from "@/components/download-button";
import { toast } from "sonner";

type VideoStatus =
  | "DRAFT_GENERATED" | "BRIEFING" | "SUBMITTING_TAKES" | "GENERATING_TAKES"
  | "ASSEMBLING" | "AWAITING_REVIEW" | "APPROVED" | "REJECTED"
  | "REMAKE_REQUESTED" | "REGENERATING" | "COMPLETED" | "FAILED";

interface TakeStatus {
  takeIndex: number;
  status: string;
  durationSeconds: number | null;
}

interface GeneratedVideo {
  id: string;
  title: string | null;
  status: VideoStatus;
  version: number;
  durationSeconds: number | null;
  takeCount: number;
  finalVideoUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  currentStep: string | null;
  product: { name: string; thumbnailUrl: string | null };
  _count: { takes: number };
  takes: TakeStatus[];
}

const STATUS_LABELS: Record<VideoStatus, string> = {
  DRAFT_GENERATED: "Criado",
  BRIEFING: "Gerando Brief",
  SUBMITTING_TAKES: "Enviando Takes",
  GENERATING_TAKES: "Gerando Takes",
  ASSEMBLING: "Montando",
  AWAITING_REVIEW: "Aguardando Review",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  REMAKE_REQUESTED: "Refação Pedida",
  REGENERATING: "Refazendo",
  COMPLETED: "Concluído",
  FAILED: "Falhou",
};

const STATUS_ICONS: Record<VideoStatus, React.ElementType> = {
  DRAFT_GENERATED: Clock,
  BRIEFING: Loader2,
  SUBMITTING_TAKES: Loader2,
  GENERATING_TAKES: Loader2,
  ASSEMBLING: Loader2,
  AWAITING_REVIEW: Eye,
  APPROVED: CheckCircle,
  REJECTED: XCircle,
  REMAKE_REQUESTED: RotateCcw,
  REGENERATING: Loader2,
  COMPLETED: CheckCircle,
  FAILED: AlertCircle,
};

const STATUS_COLORS: Record<VideoStatus, string> = {
  DRAFT_GENERATED: "text-white/40",
  BRIEFING: "text-violet-400",
  SUBMITTING_TAKES: "text-violet-400",
  GENERATING_TAKES: "text-cyan-400",
  ASSEMBLING: "text-cyan-400",
  AWAITING_REVIEW: "text-yellow-400",
  APPROVED: "text-emerald-400",
  REJECTED: "text-red-400",
  REMAKE_REQUESTED: "text-orange-400",
  REGENERATING: "text-violet-400",
  COMPLETED: "text-emerald-400",
  FAILED: "text-red-400",
};

const IN_PROGRESS: VideoStatus[] = ["BRIEFING", "SUBMITTING_TAKES", "GENERATING_TAKES", "ASSEMBLING", "REGENERATING", "DRAFT_GENERATED"];

function VideoCard({ video, onRefresh, onDeleted }: { video: GeneratedVideo; onRefresh: () => void; onDeleted: (id: string) => void }) {
  const Icon = STATUS_ICONS[video.status];
  const color = STATUS_COLORS[video.status];
  const isInProgress = IN_PROGRESS.includes(video.status);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm("Apagar esse vídeo? Essa ação não pode ser desfeita.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/ugc/generations/${video.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Vídeo apagado");
        onDeleted(video.id);
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error ?? "Erro ao apagar");
        setDeleting(false);
      }
    } catch {
      toast.error("Erro ao apagar");
      setDeleting(false);
    }
  };

  return (
    <Card className="bg-white/[0.03] border-white/[0.06] overflow-hidden">
      {/* Thumbnail / Preview */}
      <div className="aspect-[9/16] max-h-48 bg-white/5 relative overflow-hidden flex items-center justify-center">
        {video.finalVideoUrl ? (
          <video src={video.finalVideoUrl} className="w-full h-full object-cover" muted playsInline />
        ) : video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <Video className="w-8 h-8 text-white/20" />
        )}
        {isInProgress && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-white animate-spin" />
          </div>
        )}
        {video.version > 1 && (
          <div className="absolute top-2 right-2 bg-black/70 rounded px-1.5 py-0.5 text-xs text-white/70">
            v{video.version}
          </div>
        )}
      </div>

      <div className="p-3 space-y-2">
        {/* Product & status */}
        <div>
          <p className="text-xs text-white/40 truncate">{video.product.name}</p>
          <p className="text-sm font-medium text-white truncate">{video.title ?? `Vídeo ${video.id.slice(-6)}`}</p>
        </div>

        <div className={`flex items-center gap-1.5 ${color}`}>
          <Icon className={`w-3.5 h-3.5 ${isInProgress ? "animate-spin" : ""}`} />
          <span className="text-xs font-medium">{STATUS_LABELS[video.status]}</span>
        </div>

        {/* Take progress */}
        {isInProgress && video.takes && video.takes.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex gap-1">
              {video.takes.map((take) => {
                const bg = take.status === "COMPLETED" ? "bg-emerald-500"
                  : take.status === "PROCESSING" ? "bg-cyan-400 animate-pulse"
                  : take.status === "FAILED" ? "bg-red-500"
                  : "bg-white/10";
                return (
                  <div
                    key={take.takeIndex}
                    className={`flex-1 h-1.5 rounded-full ${bg}`}
                    title={`Take ${take.takeIndex + 1}: ${take.status}`}
                  />
                );
              })}
            </div>
            <p className="text-xs text-white/30">
              {(() => {
                const completed = video.takes.filter(t => t.status === "COMPLETED").length;
                const processing = video.takes.filter(t => t.status === "PROCESSING").length;
                const failed = video.takes.filter(t => t.status === "FAILED").length;
                const total = video.takes.length;
                if (processing > 0) return `Take ${completed + 1}/${total} gerando...`;
                if (completed === total) return `${total} takes prontos, montando...`;
                if (failed > 0) return `${completed}/${total} prontos, ${failed} falhou`;
                return `${completed}/${total} prontos, aguardando...`;
              })()}
            </p>
          </div>
        )}

        {/* Meta */}
        <div className="flex gap-3 text-xs text-white/30">
          {video.durationSeconds && <span>{Math.round(video.durationSeconds)}s</span>}
          <span>{video._count.takes} takes</span>
          {isInProgress ? (
            <span>{(() => {
              const mins = Math.floor((Date.now() - new Date(video.createdAt).getTime()) / 60000);
              return mins < 1 ? "agora" : `${mins}min atrás`;
            })()}</span>
          ) : (
            <span>{new Date(video.createdAt).toLocaleDateString("pt-BR")}</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Link href={`/ugc/review?id=${video.id}`} className="flex-1">
            <Button size="sm" variant="outline" className="w-full border-white/10 text-white/60 hover:text-white text-xs h-8">
              <Eye className="w-3 h-3 mr-1" />
              {video.status === "AWAITING_REVIEW" ? "Revisar" : "Ver"}
            </Button>
          </Link>
          {video.finalVideoUrl && (
            <DownloadButton
              url={video.finalVideoUrl}
              filename={`ugc-${video.id.slice(-8)}.mp4`}
              size="sm"
              variant="outline"
              className="border-white/10 text-white/60 hover:text-white text-xs h-8 px-2"
              iconOnly
            />
          )}
          {isInProgress && (
            <Button size="sm" variant="outline" className="border-white/10 text-white/60 hover:text-white text-xs h-8 px-2" onClick={onRefresh}>
              <RotateCcw className="w-3 h-3" />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/40 text-xs h-8 px-2"
            onClick={handleDelete}
            disabled={deleting}
            title="Apagar"
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function GenerationsPage() {
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "12" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/ugc/generations?${params}`);
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh for in-progress videos
  useEffect(() => {
    const hasInProgress = videos.some((v) => IN_PROGRESS.includes(v.status));
    if (!hasInProgress) return;
    const timer = setTimeout(load, 5000);
    return () => clearTimeout(timer);
  }, [videos, load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/ugc/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(`${json.videosCreated} vídeo em geração!`);
        load();
      } else {
        toast.error(json.error ?? "Erro ao gerar");
      }
    } finally {
      setGenerating(false);
    }
  };

  const filters = [
    { label: "Todos", value: "" },
    { label: "Em Geração", value: "GENERATING_TAKES" },
    { label: "Para Revisar", value: "AWAITING_REVIEW" },
    { label: "Aprovados", value: "COMPLETED" },
    { label: "Falhas", value: "FAILED" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Video className="w-5 h-5 text-violet-400" />
            Vídeos Gerados
          </h1>
          <p className="text-sm text-white/40 mt-1">{total} vídeo{total !== 1 ? "s" : ""} no total</p>
        </div>
        <Button size="sm" onClick={handleGenerate} disabled={generating} className="bg-violet-600 hover:bg-violet-700 text-white">
          {generating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
          Gerar Novo
        </Button>
      </div>

      <div className="flex gap-2 flex-wrap">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => { setStatusFilter(f.value); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === f.value
                ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                : "text-white/40 hover:text-white hover:bg-white/[0.05] border border-transparent"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : videos.length === 0 ? (
        <Card className="bg-white/[0.02] border-white/[0.06] p-12 text-center">
          <Video className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <p className="text-white/40 text-sm">Nenhum vídeo gerado ainda</p>
          <p className="text-white/20 text-xs mt-1">Aprove produtos e clique em "Gerar Novo" para começar</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              onRefresh={load}
              onDeleted={(id) => {
                setVideos((prev) => prev.filter((x) => x.id !== id));
                setTotal((t) => Math.max(0, t - 1));
              }}
            />
          ))}
        </div>
      )}

      {total > 12 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-white/40">Mostrando {Math.min((page - 1) * 12 + 1, total)}–{Math.min(page * 12, total)} de {total}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-white/10 text-white/60" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" className="border-white/10 text-white/60" onClick={() => setPage((p) => p + 1)} disabled={page * 12 >= total}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
