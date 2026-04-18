"use client";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  CheckCircle, XCircle, RotateCcw, Loader2, Video, Play, Pause,
  ChevronDown, ChevronUp, Download, FileText, Code, Activity, Scissors,
  Trash2, RefreshCw, Undo2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DownloadButton } from "@/components/download-button";
import { toast } from "sonner";
import { proxyImage } from "@/lib/ugc/image-url";

interface Take {
  id: string;
  takeIndex: number;
  status: string;
  videoUrl: string | null;
  script: string | null;
  veoPrompt: string | null;
  excluded?: boolean;
  regenerationFeedback?: string | null;
}

interface Review {
  decision: string;
  notes: string | null;
  reviewedAt: string;
}

interface LogEntry {
  step: string;
  status: string;
  message: string | null;
  createdAt: string;
  durationMs: number | null;
}

interface VideoDetail {
  id: string;
  title: string | null;
  status: string;
  version: number;
  parentVideoId: string | null;
  finalVideoUrl: string | null;
  durationSeconds: number | null;
  takeCount: number;
  script: string | null;
  copyByTake: Record<string, string> | null;
  veoPrompts: Record<string, string> | null;
  creativeBriefSnapshot: Record<string, unknown> | null;
  audioUrl: string | null;
  createdAt: string;
  product: {
    name: string;
    thumbnailUrl: string | null;
    category: string | null;
    detectedVideos?: Array<{
      videoId: string;
      videoUrl: string | null;
      thumbnailUrl: string | null;
      creatorHandle: string | null;
      description: string | null;
      views: number;
    }>;
  };
  takes: Take[];
  logs: LogEntry[];
  reviews: Review[];
}

type Tab = "video" | "reference" | "script" | "prompts" | "brief" | "takes" | "logs";

function VideoPlayer({ src }: { src: string }) {
  const [playing, setPlaying] = useState(false);
  const ref = useState<HTMLVideoElement | null>(null);

  return (
    <div className="relative bg-black rounded-xl overflow-hidden aspect-[9/16] max-w-[280px] mx-auto">
      <video
        src={src}
        className="w-full h-full object-cover"
        loop
        playsInline
        ref={(el) => { ref[1](el); }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={(e) => {
          const v = e.currentTarget;
          playing ? v.pause() : v.play();
        }}
      />
      <button
        className="absolute inset-0 flex items-center justify-center"
        onClick={(e) => {
          e.preventDefault();
          const v = e.currentTarget.previousElementSibling as HTMLVideoElement;
          if (v) playing ? v.pause() : v.play();
        }}
      >
        {!playing && (
          <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
            <Play className="w-5 h-5 text-white ml-0.5" />
          </div>
        )}
      </button>
    </div>
  );
}

function RemakeModal({ onSubmit, onClose }: { onSubmit: (feedback: string) => void; onClose: () => void }) {
  const [feedback, setFeedback] = useState("");
  const examples = [
    "Deixa o hook mais forte",
    "Mostre mais o produto",
    "Menos robótico, mais natural",
    "Quero um tom mais emocional",
    "Outro ângulo completamente diferente",
    "Faz parecer mais review real",
    "Mais energia e empolgação",
    "CTA mais fluido e natural",
  ];

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0f1117] border border-white/10 rounded-xl p-6 w-full max-w-lg">
        <h3 className="text-lg font-bold text-white mb-2">Pedir Refação</h3>
        <p className="text-sm text-white/40 mb-4">Diga o que precisa melhorar no vídeo:</p>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder-white/30 resize-none focus:outline-none focus:border-violet-500/50"
          rows={4}
          placeholder="Ex: O hook está fraco, quero algo mais impactante. Mostre mais o produto em uso..."
          autoFocus
        />
        <div className="mt-3 mb-4">
          <p className="text-xs text-white/30 mb-2">Exemplos rápidos:</p>
          <div className="flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setFeedback((prev) => prev ? `${prev}. ${ex}` : ex)}
                className="px-2 py-1 rounded text-xs bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 border-white/10 text-white/60 hover:text-white" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
            onClick={() => { if (feedback.trim()) onSubmit(feedback.trim()); }}
            disabled={!feedback.trim()}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Refazer
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const videoId = searchParams.get("id");

  const [queue, setQueue] = useState<{ id: string; title: string; product: { name: string }; status: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(videoId);
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [tab, setTab] = useState<Tab>("video");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [showRemake, setShowRemake] = useState(false);
  const [regenTakeId, setRegenTakeId] = useState<string | null>(null);
  const [regenFeedback, setRegenFeedback] = useState("");

  const loadQueue = useCallback(async () => {
    const res = await fetch("/api/ugc/generations?status=AWAITING_REVIEW&limit=20");
    if (res.ok) {
      const data = await res.json();
      setQueue(data.videos);
      if (!selectedId && data.videos.length > 0) setSelectedId(data.videos[0].id);
    }
  }, [selectedId]);

  const loadVideo = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ugc/generations/${id}`);
      if (res.ok) setVideo(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { if (selectedId) loadVideo(selectedId); }, [selectedId, loadVideo]);

  // Polling automático: enquanto o vídeo estiver regerando takes ou em
  // reassembly, dá poke a cada 6s pra atualizar status e remontar quando
  // todos os takes não-excluídos terminarem.
  useEffect(() => {
    if (!video || !selectedId) return;
    const isActive =
      video.status === "GENERATING_TAKES" ||
      video.status === "ASSEMBLING" ||
      video.status === "SUBMITTING_TAKES" ||
      video.takes.some((t) => !t.excluded && (t.status === "QUEUED" || t.status === "PROCESSING"));
    if (!isActive) return;
    const id = setInterval(() => { loadVideo(selectedId); }, 6000);
    return () => clearInterval(id);
  }, [video, selectedId, loadVideo]);

  const handleReview = async (decision: "APPROVED" | "REJECTED", notes?: string) => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/ugc/generations/${selectedId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, notes }),
      });
      if (res.ok) {
        toast.success(decision === "APPROVED" ? "Vídeo aprovado!" : "Vídeo rejeitado");
        await loadQueue();
        setSelectedId(null);
        setVideo(null);
      } else {
        toast.error("Erro ao processar review");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleTakeAction = async (takeId: string, action: "remove" | "restore" | "regenerate", feedback?: string) => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/ugc/generations/${selectedId}/takes/${takeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, feedback }),
      });
      if (res.ok) {
        toast.success(
          action === "remove" ? "Take removido — vídeo será remontado" :
          action === "restore" ? "Take restaurado" :
          "Regenerando take — aguarde"
        );
        await loadVideo(selectedId);
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error ?? "Erro ao processar take");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemake = async (feedback: string) => {
    if (!selectedId) return;
    setShowRemake(false);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/ugc/generations/${selectedId}/remake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Refação iniciada! Novo vídeo sendo gerado.");
        await loadQueue();
        setSelectedId(json.newVideoId ?? null);
      } else {
        toast.error(json.error ?? "Erro ao pedir refação");
      }
    } finally {
      setActionLoading(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "video", label: "Vídeo", icon: Video },
    { id: "reference", label: "Referência", icon: Video },
    { id: "script", label: "Roteiro", icon: FileText },
    { id: "prompts", label: "Prompts Veo", icon: Code },
    { id: "brief", label: "Brief", icon: Activity },
    { id: "takes", label: "Takes", icon: Play },
    { id: "logs", label: "Logs", icon: Activity },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-white">Review de Vídeos</h1>
        <p className="text-sm text-white/40 mt-1">{queue.length} vídeo{queue.length !== 1 ? "s" : ""} aguardando sua aprovação</p>
      </div>

      {queue.length === 0 && !loading ? (
        <Card className="bg-white/[0.02] border-white/[0.06] p-12 text-center">
          <CheckCircle className="w-10 h-10 text-emerald-400/50 mx-auto mb-3" />
          <p className="text-white/40 text-sm">Nenhum vídeo aguardando review</p>
          <p className="text-white/20 text-xs mt-1">Quando novos vídeos forem gerados, eles aparecerão aqui</p>
        </Card>
      ) : (
        <div className="flex gap-4">
          {/* Queue sidebar */}
          <div className="w-48 shrink-0 space-y-2">
            <p className="text-xs text-white/30 uppercase tracking-wide px-1">Fila</p>
            {queue.map((q) => (
              <button
                key={q.id}
                onClick={() => setSelectedId(q.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  selectedId === q.id
                    ? "bg-violet-500/20 text-white border border-violet-500/30"
                    : "text-white/50 hover:text-white hover:bg-white/[0.05] border border-transparent"
                }`}
              >
                <p className="font-medium truncate">{q.product?.name ?? "Produto"}</p>
                <p className="text-xs text-white/30 truncate">{q.title ?? q.id.slice(-8)}</p>
              </button>
            ))}
          </div>

          {/* Main review area */}
          <div className="flex-1 min-w-0">
            {loading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
              </div>
            ) : video ? (
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-white/40">{video.product.name}</p>
                    <h2 className="text-lg font-bold text-white">{video.title ?? "Vídeo gerado"}</h2>
                    <p className="text-xs text-white/30">
                      v{video.version} • {video.durationSeconds ? `${Math.round(video.durationSeconds)}s` : "?"} • {video.takeCount} takes
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {video.finalVideoUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-white/10 text-white/60 hover:text-white"
                        onClick={() => router.push(`/ugc/edit?id=${video.id}`)}
                      >
                        <Scissors className="w-3.5 h-3.5 mr-1.5" />
                        Editar
                      </Button>
                    )}
                    {video.finalVideoUrl && (
                      <DownloadButton
                        url={video.finalVideoUrl}
                        filename={`ugc-${video.id.slice(-8)}.mp4`}
                        label="Download"
                        size="sm"
                        variant="outline"
                        className="border-white/10 text-white/60 hover:text-white"
                      />
                    )}
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 border-b border-white/[0.06] pb-0">
                  {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                        tab === id
                          ? "border-violet-500 text-violet-300"
                          : "border-transparent text-white/40 hover:text-white"
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      {label}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="min-h-[300px]">
                  {tab === "video" && (
                    <div className="flex flex-col items-center gap-4">
                      {video.finalVideoUrl ? (
                        <VideoPlayer src={video.finalVideoUrl} />
                      ) : (
                        <div className="w-[280px] aspect-[9/16] bg-white/5 rounded-xl flex items-center justify-center">
                          <div className="text-center">
                            <Loader2 className="w-8 h-8 text-violet-400 animate-spin mx-auto mb-2" />
                            <p className="text-xs text-white/40">{video.status}</p>
                          </div>
                        </div>
                      )}

                      {/* Previous versions */}
                      {video.parentVideoId && (
                        <button
                          onClick={() => setSelectedId(video.parentVideoId!)}
                          className="text-xs text-white/30 hover:text-white/60 transition-colors"
                        >
                          Ver versão anterior
                        </button>
                      )}
                    </div>
                  )}

                  {tab === "reference" && (
                    <div className="flex flex-col items-center gap-3">
                      {(() => {
                        const ref = video.product.detectedVideos?.[0];
                        if (!ref) return <p className="text-white/30 text-sm">Sem vídeo de referência.</p>;
                        const tiktokUrl = ref.videoUrl ?? (ref.creatorHandle && ref.videoId ? `https://www.tiktok.com/@${ref.creatorHandle}/video/${ref.videoId}` : null);
                        return (
                          <>
                            <p className="text-xs text-white/40 text-center">Vídeo de referência usado pra gerar este UGC</p>
                            {ref.thumbnailUrl && (
                              <img src={proxyImage(ref.thumbnailUrl)} alt="Referência" className="max-w-[280px] rounded-xl aspect-[9/16] object-cover" />
                            )}
                            <div className="text-center space-y-1">
                              {ref.creatorHandle && <p className="text-sm text-white">@{ref.creatorHandle}</p>}
                              <p className="text-xs text-white/40">{Number(ref.views).toLocaleString("pt-BR")} views</p>
                              {ref.description && <p className="text-xs text-white/50 max-w-sm mx-auto">{ref.description}</p>}
                            </div>
                            {tiktokUrl && (
                              <a href={tiktokUrl} target="_blank" rel="noopener noreferrer">
                                <Button size="sm" variant="outline" className="border-white/10 text-white/70 hover:text-white">
                                  Abrir no TikTok
                                </Button>
                              </a>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {tab === "script" && (
                    <div className="space-y-4">
                      <div className="bg-white/[0.03] rounded-xl p-4">
                        <p className="text-xs text-white/30 uppercase tracking-wide mb-2">Roteiro Completo</p>
                        <p className="text-sm text-white/80 whitespace-pre-wrap">{video.script ?? "Sem roteiro"}</p>
                      </div>
                      {video.copyByTake && (
                        <div className="space-y-2">
                          {Object.entries(video.copyByTake).map(([take, script]) => (
                            <div key={take} className="bg-white/[0.03] rounded-xl p-4">
                              <p className="text-xs text-violet-400 uppercase tracking-wide mb-1">{take.replace("take", "Take ")}</p>
                              <p className="text-sm text-white/70">{String(script)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "prompts" && (
                    <div className="space-y-2">
                      {video.veoPrompts ? Object.entries(video.veoPrompts).map(([take, prompt]) => (
                        <div key={take} className="bg-white/[0.03] rounded-xl p-4">
                          <p className="text-xs text-cyan-400 uppercase tracking-wide mb-1">{take.replace("take", "Take ")}</p>
                          <p className="text-sm text-white/60 font-mono leading-relaxed">{String(prompt)}</p>
                        </div>
                      )) : <p className="text-white/30 text-sm">Sem prompts</p>}
                    </div>
                  )}

                  {tab === "brief" && (
                    <div className="bg-white/[0.03] rounded-xl p-4">
                      {video.creativeBriefSnapshot ? (
                        <pre className="text-xs text-white/60 overflow-auto">
                          {JSON.stringify(video.creativeBriefSnapshot, null, 2)}
                        </pre>
                      ) : <p className="text-white/30 text-sm">Sem brief</p>}
                    </div>
                  )}

                  {tab === "takes" && (
                    <div className="space-y-3">
                      <p className="text-xs text-white/40">
                        Remova takes que não ficaram bons, ou regenere com feedback. Depois que todos estiverem prontos, o vídeo é remontado automaticamente.
                      </p>
                      <div className="grid grid-cols-3 gap-3">
                        {video.takes.map((take) => {
                          const isPending = take.status === "QUEUED" || take.status === "PROCESSING";
                          const isFailed = take.status === "FAILED";
                          return (
                            <div key={take.id} className={`space-y-2 ${take.excluded ? "opacity-40" : ""}`}>
                              <div className="aspect-[9/16] bg-white/5 rounded-lg overflow-hidden relative">
                                {take.videoUrl && !take.excluded ? (
                                  <video src={take.videoUrl} className="w-full h-full object-cover" muted loop playsInline onClick={(e) => { const v = e.currentTarget; v.paused ? v.play() : v.pause(); }} />
                                ) : take.excluded ? (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="text-center">
                                      <Trash2 className="w-5 h-5 text-white/30 mx-auto mb-1" />
                                      <p className="text-[10px] text-white/40">Removido</p>
                                    </div>
                                  </div>
                                ) : isFailed ? (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="text-center px-2">
                                      <XCircle className="w-5 h-5 text-red-400 mx-auto mb-1" />
                                      <p className="text-[10px] text-red-300">Falhou</p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                                  </div>
                                )}
                              </div>
                              <p className="text-xs text-white/40 text-center">
                                Take {take.takeIndex + 1}
                                {isPending && !take.excluded && <span className="ml-1 text-violet-400">· {take.status.toLowerCase()}</span>}
                              </p>
                              {take.script && <p className="text-[11px] text-white/30 line-clamp-2">{take.script}</p>}
                              {take.regenerationFeedback && (
                                <p className="text-[10px] text-violet-300 line-clamp-2 italic">↺ {take.regenerationFeedback}</p>
                              )}
                              <div className="flex gap-1">
                                {take.excluded ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="flex-1 h-7 text-[11px] border-white/10 text-white/60 hover:text-white"
                                    disabled={actionLoading}
                                    onClick={() => handleTakeAction(take.id, "restore")}
                                  >
                                    <Undo2 className="w-3 h-3 mr-1" />
                                    Restaurar
                                  </Button>
                                ) : (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="flex-1 h-7 text-[11px] border-white/10 text-white/60 hover:text-white"
                                      disabled={actionLoading || isPending}
                                      onClick={() => {
                                        setRegenTakeId(take.id);
                                        setRegenFeedback("");
                                      }}
                                    >
                                      <RefreshCw className="w-3 h-3 mr-1" />
                                      Regerar
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2 border-red-500/20 text-red-400 hover:bg-red-500/10"
                                      disabled={actionLoading}
                                      onClick={() => handleTakeAction(take.id, "remove")}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {tab === "logs" && (
                    <div className="space-y-1">
                      {video.logs.map((log, i) => (
                        <div key={i} className={`flex items-start gap-2 text-xs p-2 rounded ${
                          log.status === "failed" ? "bg-red-500/5" : log.status === "completed" ? "bg-emerald-500/5" : ""
                        }`}>
                          <span className={`shrink-0 ${log.status === "failed" ? "text-red-400" : log.status === "completed" ? "text-emerald-400" : "text-white/30"}`}>
                            [{log.step}]
                          </span>
                          <span className="text-white/50">{log.message ?? log.status}</span>
                          {log.durationMs && <span className="text-white/20 ml-auto shrink-0">{log.durationMs}ms</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Review actions */}
                {video.status === "AWAITING_REVIEW" && (
                  <div className="flex gap-3 pt-2 border-t border-white/[0.06]">
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={() => handleReview("APPROVED")}
                      disabled={actionLoading}
                    >
                      {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle className="w-4 h-4 mr-2" />}
                      Aprovar
                    </Button>
                    <Button
                      className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
                      onClick={() => setShowRemake(true)}
                      disabled={actionLoading}
                    >
                      <RotateCcw className="w-4 h-4 mr-2" />
                      Refazer
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 border-red-500/20 text-red-400 hover:bg-red-500/10"
                      onClick={() => handleReview("REJECTED")}
                      disabled={actionLoading}
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      Reprovar
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center py-16">
                <p className="text-white/30 text-sm">Selecione um vídeo para revisar</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showRemake && (
        <RemakeModal
          onSubmit={handleRemake}
          onClose={() => setShowRemake(false)}
        />
      )}

      {regenTakeId && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#0f1117] border border-white/10 rounded-xl p-6 w-full max-w-lg">
            <h3 className="text-lg font-bold text-white mb-2">Regerar Take</h3>
            <p className="text-sm text-white/40 mb-4">
              Diga o que quer mudar neste take (ou deixe em branco pra tentar de novo do zero). Depois que todos os takes terminarem, o vídeo é remontado automaticamente.
            </p>
            <textarea
              value={regenFeedback}
              onChange={(e) => setRegenFeedback(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder-white/30 resize-none focus:outline-none focus:border-violet-500/50"
              rows={3}
              placeholder="Ex: mostra o produto em close-up; deixa a fala mais animada; outro ângulo..."
              autoFocus
            />
            <div className="flex gap-2 mt-4">
              <Button
                variant="outline"
                className="flex-1 border-white/10 text-white/60 hover:text-white"
                onClick={() => { setRegenTakeId(null); setRegenFeedback(""); }}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
                onClick={() => {
                  handleTakeAction(regenTakeId, "regenerate", regenFeedback.trim() || undefined);
                  setRegenTakeId(null);
                  setRegenFeedback("");
                }}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Regerar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
