"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { upload } from "@vercel/blob/client";
import {
  FileVideo, Loader2, Upload, UserCircle, CheckCircle2,
  XCircle, Trash2, Download, RefreshCw, Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

interface Character {
  id: string;
  name: string;
  imageUrl: string;
}

interface Job {
  id: string;
  status: "QUEUED" | "PROCESSING" | "DONE" | "FAILED" | string;
  sourceVideoUrl: string;
  resultVideoUrl: string | null;
  errorMessage: string | null;
  character: { id: string; name: string; imageUrl: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export default function FaceSwapPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [charsRes, jobsRes] = await Promise.all([
        fetch("/api/ugc/characters"),
        fetch("/api/ugc/face-swap"),
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

  // Auto-refresh enquanto houver jobs em andamento
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === "QUEUED" || j.status === "PROCESSING");
    if (!hasActive) {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(() => {
      fetch("/api/ugc/face-swap").then((r) => r.json()).then((d) => setJobs(d.jobs));
    }, 8000);
    return () => {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    };
  }, [jobs]);

  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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
  };

  const handleSubmit = async () => {
    if (!videoFile) { toast.error("Selecione um vídeo"); return; }
    if (!selectedCharacterId) { toast.error("Escolha um personagem"); return; }

    setSubmitting(true);
    setUploadProgress(0);
    try {
      const ext = videoFile.name.split(".").pop() ?? "mp4";
      const blob = await upload(`face-swap-input-${Date.now()}.${ext}`, videoFile, {
        access: "public",
        handleUploadUrl: "/api/upload",
        clientPayload: "input_video",
        onUploadProgress: (e) => setUploadProgress(Math.round(e.percentage)),
      });

      const res = await fetch("/api/ugc/face-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceVideoUrl: blob.url,
          characterId: selectedCharacterId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Erro" }));
        toast.error(err.error ?? "Falha ao criar job");
        return;
      }

      toast.success("Processamento iniciado — aguarde ~2-5min");
      setVideoFile(null);
      setVideoPreview(null);
      setSelectedCharacterId("");
      loadAll();
    } catch (err) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remover este job?")) return;
    const res = await fetch(`/api/ugc/face-swap?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Removido");
      loadAll();
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <FileVideo className="w-5 h-5 text-violet-400" />
          Trocar Rosto no Vídeo
        </h1>
        <p className="text-sm text-white/40 mt-1">
          Suba um vídeo e escolha um personagem — trocamos o rosto da pessoa preservando voz e áudio originais.
        </p>
      </div>

      {/* Form */}
      <Card className="bg-white/[0.03] border-white/[0.08] p-5 space-y-5">
        {/* Video upload */}
        <div className="space-y-2">
          <label className="text-sm text-white/60">1. Vídeo</label>
          {videoPreview ? (
            <div className="relative max-w-md">
              <video
                src={videoPreview}
                controls
                className="w-full rounded-lg border border-white/10 bg-black"
              />
              <button
                onClick={() => { setVideoFile(null); setVideoPreview(null); }}
                className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-lg text-white/70 hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-white/10 hover:border-violet-500/30 rounded-lg p-10 cursor-pointer transition-colors">
              <Upload className="w-8 h-8 text-white/30" />
              <span className="text-sm text-white/50">Clique para enviar vídeo (máx. 2GB)</span>
              <span className="text-xs text-white/30">MP4, MOV, WebM — duração recomendada até 60s (limite Pixverse)</span>
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
          <label className="text-sm text-white/60">2. Personagem (novo rosto)</label>
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
                    <img src={char.imageUrl} alt={char.name} className="w-full h-full object-cover" />
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
            disabled={submitting || !videoFile || !selectedCharacterId}
            className="bg-violet-600 hover:bg-violet-500 text-white"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                {uploadProgress > 0 && uploadProgress < 100
                  ? `Enviando vídeo... ${uploadProgress}%`
                  : "Enviando..."}
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-1.5" />
                Trocar Rosto
              </>
            )}
          </Button>
          <p className="text-xs text-white/30 mt-2">
            Processamento tipicamente 2-5min. Áudio original é mantido.
          </p>
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
                  {/* Character avatar */}
                  {job.character ? (
                    <img
                      src={job.character.imageUrl}
                      alt={job.character.name}
                      className="w-14 h-14 rounded-lg object-cover border border-white/10 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                      <UserCircle className="w-6 h-6 text-white/20" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">
                        {job.character?.name ?? "Personagem removido"}
                      </span>
                      <StatusBadge status={job.status} />
                    </div>
                    <p className="text-xs text-white/40 mt-1">
                      {new Date(job.createdAt).toLocaleString("pt-BR")}
                    </p>
                    {job.errorMessage && (
                      <p className="text-xs text-red-400 mt-1 line-clamp-2">{job.errorMessage}</p>
                    )}

                    {/* Result video */}
                    {job.status === "DONE" && job.resultVideoUrl && (
                      <div className="mt-3">
                        <video
                          src={job.resultVideoUrl}
                          controls
                          className="max-w-sm rounded-lg border border-white/10 bg-black"
                        />
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
