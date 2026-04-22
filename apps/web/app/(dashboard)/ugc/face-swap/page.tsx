"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { upload } from "@vercel/blob/client";
import {
  FileVideo, Loader2, Upload, UserCircle, CheckCircle2,
  XCircle, Trash2, Download, RefreshCw, Play, Scissors,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CharacterAvatar } from "@/components/character-avatar";
import { toast } from "sonner";
import { splitVideo, probeVideoDuration } from "@/lib/video-splitter";

const CHUNK_SECONDS = 60;

interface Character {
  id: string;
  name: string;
  imageUrl: string;
}

interface Job {
  id: string;
  status: "QUEUED" | "PROCESSING" | "MERGING" | "DONE" | "FAILED" | string;
  sourceVideoUrl: string | null;
  resultVideoUrl: string | null;
  errorMessage: string | null;
  totalChunks: number;
  completedChunks: number;
  character: { id: string; name: string; imageUrl: string } | null;
  createdAt: string;
  completedAt: string | null;
}

type UploadPhase = "idle" | "probing" | "splitting" | "uploading" | "submitting";

export default function FaceSwapPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("");

  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [phaseMsg, setPhaseMsg] = useState("");
  const [phaseProgress, setPhaseProgress] = useState(0); // 0-100
  const [refreshingChars, setRefreshingChars] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCharacters = useCallback(async () => {
    setRefreshingChars(true);
    try {
      const res = await fetch("/api/ugc/characters", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setCharacters(data.characters);
      }
    } finally {
      setRefreshingChars(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [charsRes, jobsRes] = await Promise.all([
        fetch("/api/ugc/characters", { cache: "no-store" }),
        fetch("/api/ugc/face-swap", { cache: "no-store" }),
      ]);
      if (charsRes.ok) {
        const data = await charsRes.json();
        setCharacters(data.characters);
      }
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const hasActive = jobs.some(
      (j) => j.status === "QUEUED" || j.status === "PROCESSING" || j.status === "MERGING",
    );
    if (!hasActive) {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(() => {
      fetch("/api/ugc/face-swap", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setJobs(d.jobs))
        .catch(() => {});
    }, 8000);
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [jobs]);

  const handleVideoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      toast.error("Selecione um arquivo de vídeo");
      return;
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      toast.error("Vídeo máximo 2GB");
      return;
    }
    setVideoFile(file);
    setVideoPreview(URL.createObjectURL(file));
    setVideoDuration(null);
    try {
      const d = await probeVideoDuration(file);
      setVideoDuration(d);
    } catch {
      /* ignora — o split descobre de novo */
    }
  };

  const handleSubmit = async () => {
    if (!videoFile) { toast.error("Selecione um vídeo"); return; }
    if (!selectedCharacterId) { toast.error("Escolha um personagem"); return; }

    setPhase("probing");
    setPhaseMsg("Analisando vídeo...");
    setPhaseProgress(0);

    try {
      const duration = videoDuration ?? (await probeVideoDuration(videoFile));
      const totalExpected = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
      const uploadedChunks: { index: number; url: string }[] = [];

      setPhase(totalExpected === 1 ? "uploading" : "splitting");
      setPhaseMsg(
        totalExpected === 1
          ? "Enviando vídeo..."
          : `Splitando em ${totalExpected} pedaços de ${CHUNK_SECONDS}s...`,
      );

      await splitVideo(videoFile, {
        chunkSeconds: CHUNK_SECONDS,
        onProgress: (_phase, current, total) => {
          const pct = total > 0 ? Math.round((current / total) * 40) : 0;
          setPhaseProgress(pct);
        },
        onChunk: async (chunk) => {
          setPhase("uploading");
          setPhaseMsg(
            totalExpected === 1
              ? "Enviando vídeo..."
              : `Enviando chunk ${chunk.index + 1}/${totalExpected}...`,
          );
          const filename = `face-swap-in-${Date.now()}-${String(chunk.index).padStart(4, "0")}.mp4`;
          const file =
            chunk.blob instanceof File
              ? chunk.blob
              : new File([chunk.blob], filename, { type: "video/mp4" });
          const blob = await upload(filename, file, {
            access: "public",
            handleUploadUrl: "/api/upload",
            clientPayload: "input_video",
          });
          uploadedChunks.push({ index: chunk.index, url: blob.url });
          // 40%..90% reservado pro upload
          const pct = 40 + Math.round((uploadedChunks.length / totalExpected) * 50);
          setPhaseProgress(Math.min(90, pct));
        },
      });

      setPhase("submitting");
      setPhaseMsg("Submetendo pro Fal Pixverse...");
      setPhaseProgress(95);

      const res = await fetch("/api/ugc/face-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterId: selectedCharacterId,
          chunks: uploadedChunks,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Erro" }));
        toast.error(err.error ?? "Falha ao criar job");
        return;
      }

      toast.success(
        totalExpected === 1
          ? "Processando — aguarde ~2-5min"
          : `Processando ${totalExpected} chunks em paralelo — aguarde`,
      );
      setVideoFile(null);
      setVideoPreview(null);
      setVideoDuration(null);
      setSelectedCharacterId("");
      loadAll();
    } catch (err) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPhase("idle");
      setPhaseMsg("");
      setPhaseProgress(0);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remover este job?")) return;
    const res = await fetch(`/api/ugc/face-swap?id=${id}`, { method: "DELETE" });
    if (res.ok) { toast.success("Removido"); loadAll(); }
  };

  const busy = phase !== "idle";
  const expectedChunks = videoDuration != null ? Math.max(1, Math.ceil(videoDuration / CHUNK_SECONDS)) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileVideo className="w-5 h-5 text-violet-400" />
          Trocar Rosto no Vídeo
        </h1>
        <p className="text-sm text-white/40 mt-1">
          Suba um vídeo (até 2GB). Pra vídeos longos, splitamos em pedaços de 60s e processamos em paralelo — áudio e voz originais preservados.
        </p>
      </div>

      <Card className="bg-white/[0.03] border-white/[0.08] p-5 space-y-5">
        {/* Video upload */}
        <div className="space-y-2">
          <label className="text-sm text-white/60">1. Vídeo</label>
          {videoPreview ? (
            <div className="relative max-w-md">
              <video src={videoPreview} controls className="w-full rounded-lg border border-white/10 bg-black" />
              {videoDuration != null && (
                <p className="text-xs text-white/50 mt-1.5 flex items-center gap-2">
                  <Scissors className="w-3 h-3" />
                  {formatDuration(videoDuration)} ·{" "}
                  {expectedChunks! > 1
                    ? `será splitado em ${expectedChunks} pedaços de ${CHUNK_SECONDS}s`
                    : "vídeo curto, processado em 1 chunk só"}
                </p>
              )}
              <button
                onClick={() => { setVideoFile(null); setVideoPreview(null); setVideoDuration(null); }}
                className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-lg text-white/70 hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-white/10 hover:border-violet-500/30 rounded-lg p-10 cursor-pointer transition-colors">
              <Upload className="w-8 h-8 text-white/30" />
              <span className="text-sm text-white/50">Clique para enviar vídeo (máx. 2GB)</span>
              <span className="text-xs text-white/30">MP4, MOV, WebM — qualquer duração</span>
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                onChange={handleVideoSelect}
                className="hidden"
              />
            </label>
          )}
        </div>

        {/* Character select */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm text-white/60">2. Personagem (novo rosto)</label>
            <Button
              size="sm"
              variant="ghost"
              onClick={loadCharacters}
              disabled={refreshingChars}
              className="h-7 text-xs text-white/50 hover:text-white"
            >
              <RefreshCw className={`w-3 h-3 mr-1 ${refreshingChars ? "animate-spin" : ""}`} />
              Atualizar personagens
            </Button>
          </div>
          {characters.length === 0 ? (
            <p className="text-xs text-white/40">
              Nenhum personagem cadastrado. Crie um em{" "}
              <a href="/ugc/personagens" className="text-violet-400 hover:underline">Personagens</a>.
            </p>
          ) : (
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {characters.map((char) => {
                const isSelected = selectedCharacterId === char.id;
                return (
                  <button
                    key={char.id}
                    onClick={() => setSelectedCharacterId(char.id)}
                    className={`relative aspect-[3/4] rounded-lg overflow-hidden border-2 transition-all ${
                      isSelected
                        ? "border-violet-500 ring-2 ring-violet-500/30"
                        : "border-white/10 hover:border-white/30"
                    }`}
                  >
                    <CharacterAvatar name={char.name} imageUrl={char.imageUrl} />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 p-2">
                      <p className="text-xs font-semibold text-white truncate">{char.name}</p>
                    </div>
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-violet-500 flex items-center justify-center">
                        <CheckCircle2 className="w-3 h-3 text-white" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Submit */}
        <div>
          <Button
            onClick={handleSubmit}
            disabled={busy || !videoFile || !selectedCharacterId}
            className="bg-violet-600 hover:bg-violet-500 text-white"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                {phaseMsg || "Processando..."}
                {phaseProgress > 0 && ` ${phaseProgress}%`}
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-1.5" />
                Trocar Rosto
              </>
            )}
          </Button>
          <p className="text-xs text-white/30 mt-2">
            Vídeo curto: ~2-5min. Vídeo longo: cada pedaço de 60s vira 1 request Pixverse (~$0.10-0.30 cada).
          </p>
          {busy && phaseProgress > 0 && (
            <div className="mt-3 h-1.5 w-full max-w-md bg-white/5 rounded overflow-hidden">
              <div className="h-full bg-violet-500 transition-all" style={{ width: `${phaseProgress}%` }} />
            </div>
          )}
        </div>
      </Card>

      {/* Jobs list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-white/80">Jobs recentes</h2>
          <Button size="sm" variant="ghost" onClick={loadAll}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            Atualizar
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <Card className="bg-white/[0.02] border-white/[0.06] p-8 text-center">
            <p className="text-sm text-white/40">Nenhum job ainda</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <Card key={job.id} className="bg-white/[0.03] border-white/[0.06] p-4">
                <div className="flex items-start gap-4">
                  {job.character ? (
                    <div className="w-14 h-14 rounded-lg overflow-hidden border border-white/10 flex-shrink-0">
                      <CharacterAvatar name={job.character.name} imageUrl={job.character.imageUrl} />
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                      <UserCircle className="w-6 h-6 text-white/20" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">
                        {job.character?.name ?? "Personagem removido"}
                      </span>
                      <StatusBadge status={job.status} />
                      {job.totalChunks > 1 && (
                        <span className="text-[10px] text-white/50">
                          {job.completedChunks}/{job.totalChunks} chunks
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/40 mt-1">
                      {new Date(job.createdAt).toLocaleString("pt-BR")}
                    </p>

                    {job.totalChunks > 1 && job.status === "PROCESSING" && (
                      <div className="mt-2 h-1 w-full max-w-xs bg-white/5 rounded overflow-hidden">
                        <div
                          className="h-full bg-violet-500"
                          style={{ width: `${Math.round((job.completedChunks / job.totalChunks) * 100)}%` }}
                        />
                      </div>
                    )}

                    {job.errorMessage && (
                      <p className="text-xs text-red-400 mt-1 line-clamp-2">{job.errorMessage}</p>
                    )}

                    {job.status === "DONE" && job.resultVideoUrl && (
                      <div className="mt-3">
                        <video src={job.resultVideoUrl} controls className="max-w-sm rounded-lg border border-white/10 bg-black" />
                        <div className="mt-2 flex gap-2">
                          <a
                            href={job.resultVideoUrl}
                            download
                            className="inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200"
                          >
                            <Download className="w-3 h-3" />
                            Baixar
                          </a>
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => handleDelete(job.id)}
                    className="p-1.5 text-white/30 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    QUEUED: {
      label: "Na fila",
      cls: "bg-blue-500/10 text-blue-300 border-blue-500/20",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
    },
    PROCESSING: {
      label: "Processando",
      cls: "bg-violet-500/10 text-violet-300 border-violet-500/20",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
    },
    MERGING: {
      label: "Juntando",
      cls: "bg-amber-500/10 text-amber-300 border-amber-500/20",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
    },
    DONE: {
      label: "Pronto",
      cls: "bg-green-500/10 text-green-300 border-green-500/20",
      icon: <CheckCircle2 className="w-3 h-3" />,
    },
    FAILED: {
      label: "Falhou",
      cls: "bg-red-500/10 text-red-300 border-red-500/20",
      icon: <XCircle className="w-3 h-3" />,
    },
  };
  const s = map[status] ?? { label: status, cls: "bg-white/5 text-white/50 border-white/10", icon: null };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
