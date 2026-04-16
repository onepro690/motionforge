"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Loader2,
  Sparkles,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FileUpload,
  type UploadedFile,
} from "@/components/upload/file-upload";

// ─── Types ────────────────────────────────────────────────────────────────────

type TakeItem = {
  id: string;
  imageFile: UploadedFile | null;
  videoFile: UploadedFile | null;
};

type TakeJob = {
  takeIndex: number;
  jobId: string;
  status: string; // QUEUED | PROCESSING | RENDERING | COMPLETED | FAILED
  progress: number;
  outputVideoUrl: string | null;
  errorMessage: string | null;
};

type Phase = "setup" | "generating" | "merging" | "done";

// ─── Schema ───────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  aspectRatio: z.enum(["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3"]),
  resolution: z.enum(["SD_480", "HD_720", "FHD_1080"]),
  motionStrength: z.number().min(0).max(1),
  identityStrength: z.number().min(0).max(1),
  facePreserveStrength: z.number().min(0).max(1),
  backgroundMode: z.enum(["KEEP", "REMOVE", "BLUR", "REPLACE"]),
});

type SettingsData = z.infer<typeof settingsSchema>;

const CREDITS_PER_SECOND: Record<string, number> = {
  SD_480: 16,
  HD_720: 16,
  FHD_1080: 32,
};

// ─── Take Card ────────────────────────────────────────────────────────────────

function TakeCard({
  take,
  index,
  onUpdate,
  onRemove,
  canRemove,
}: {
  take: TakeItem;
  index: number;
  onUpdate: (id: string, field: "imageFile" | "videoFile", value: UploadedFile | null) => void;
  onRemove: (id: string) => void;
  canRemove: boolean;
}) {
  return (
    <Card className="bg-white/[0.03] border-white/[0.08]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-white text-sm font-medium">
            Take {index + 1}
          </CardTitle>
          {canRemove && (
            <button
              type="button"
              onClick={() => onRemove(take.id)}
              className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-white/60 mb-2 block text-xs">Avatar</Label>
          <FileUpload
            icon="image"
            accept="image/png,image/jpeg,image/webp"
            maxSize={50 * 1024 * 1024}
            label="Imagem do avatar"
            hint="PNG, JPG ou WebP"
            value={take.imageFile}
            onChange={(f) => onUpdate(take.id, "imageFile", f)}
          />
        </div>
        <div>
          <Label className="text-white/60 mb-2 block text-xs">
            Vídeo de Referência
          </Label>
          <FileUpload
            icon="video"
            accept="video/mp4,video/quicktime,video/webm"
            maxSize={500 * 1024 * 1024}
            label="Vídeo de movimento"
            hint="MP4, MOV ou WebM"
            value={take.videoFile}
            onChange={(f) => onUpdate(take.id, "videoFile", f)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Generating Card ──────────────────────────────────────────────────────────

function GeneratingCard({ job }: { job: TakeJob }) {
  const statusLabels: Record<string, string> = {
    QUEUED: "Na fila...",
    PROCESSING: "Processando...",
    RENDERING: "Renderizando...",
    COMPLETED: "Concluído",
    FAILED: "Falhou",
  };

  const isCompleted = job.status === "COMPLETED";
  const isFailed = job.status === "FAILED";

  return (
    <Card className="bg-white/[0.03] border-white/[0.08]">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">
            Take {job.takeIndex + 1}
          </span>
          <div className="flex items-center gap-2">
            {isCompleted && (
              <CheckCircle2 className="w-4 h-4 text-green-400" />
            )}
            {isFailed && <XCircle className="w-4 h-4 text-red-400" />}
            {!isCompleted && !isFailed && (
              <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
            )}
            <span
              className={
                isCompleted
                  ? "text-xs text-green-400"
                  : isFailed
                  ? "text-xs text-red-400"
                  : "text-xs text-white/50"
              }
            >
              {statusLabels[job.status] ?? job.status}
            </span>
          </div>
        </div>

        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              isFailed ? "bg-red-500" : "bg-violet-500"
            }`}
            style={{
              width: `${
                isCompleted ? 100 : isFailed ? 100 : job.progress
              }%`,
            }}
          />
        </div>

        {job.errorMessage && (
          <p className="text-xs text-red-400">{job.errorMessage}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TakesPage() {
  const [takes, setTakes] = useState<TakeItem[]>([
    { id: crypto.randomUUID(), imageFile: null, videoFile: null },
    { id: crypto.randomUUID(), imageFile: null, videoFile: null },
  ]);
  const [phase, setPhase] = useState<Phase>("setup");
  const [takeJobs, setTakeJobs] = useState<TakeJob[]>([]);
  const [mergedVideoUrl, setMergedVideoUrl] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { control } = useForm<SettingsData>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      aspectRatio: "RATIO_16_9",
      resolution: "HD_720",
      motionStrength: 0.8,
      identityStrength: 0.9,
      facePreserveStrength: 0.85,
      backgroundMode: "KEEP",
    },
  });

  const resolution = useWatch({ control, name: "resolution" });
  const creditsPerSecond = CREDITS_PER_SECOND[resolution] ?? 16;

  const totalCredits = takes.reduce((sum, take) => {
    const dur = take.videoFile?.duration ?? null;
    return sum + (dur !== null ? Math.ceil(dur * creditsPerSecond) : 0);
  }, 0);

  const allTakesReady = takes.every((t) => t.imageFile && t.videoFile);

  // ── Take management ──

  const addTake = () => {
    if (takes.length >= 8) return;
    setTakes((prev) => [
      ...prev,
      { id: crypto.randomUUID(), imageFile: null, videoFile: null },
    ]);
  };

  const removeTake = (id: string) => {
    setTakes((prev) => prev.filter((t) => t.id !== id));
  };

  const updateTake = (
    id: string,
    field: "imageFile" | "videoFile",
    value: UploadedFile | null
  ) => {
    setTakes((prev) =>
      prev.map((t) => (t.id === id ? { ...t, [field]: value } : t))
    );
  };

  // ── Polling ──

  const pollJobs = useCallback(async (jobs: TakeJob[]) => {
    const pendingJobs = jobs.filter(
      (j) => j.status !== "COMPLETED" && j.status !== "FAILED"
    );
    if (pendingJobs.length === 0) return;

    const updated = await Promise.all(
      pendingJobs.map(async (j) => {
        try {
          const res = await fetch(`/api/jobs/${j.jobId}`);
          if (!res.ok) return j;
          const data = await res.json();
          return {
            ...j,
            status: data.status,
            outputVideoUrl: data.outputVideoUrl ?? null,
            errorMessage: data.errorMessage ?? null,
            progress:
              data.status === "COMPLETED"
                ? 100
                : data.status === "RENDERING"
                ? 70
                : data.status === "PROCESSING"
                ? 40
                : 10,
          };
        } catch {
          return j;
        }
      })
    );

    setTakeJobs((prev) =>
      prev.map((j) => {
        const upd = updated.find((u) => u.jobId === j.jobId);
        return upd ?? j;
      })
    );
  }, []);

  useEffect(() => {
    if (phase !== "generating") return;
    pollRef.current = setInterval(() => {
      setTakeJobs((current) => {
        pollJobs(current);
        return current;
      });
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, pollJobs]);

  // Watch for all jobs completing
  useEffect(() => {
    if (phase !== "generating" || takeJobs.length === 0) return;
    const allDone = takeJobs.every(
      (j) => j.status === "COMPLETED" || j.status === "FAILED"
    );
    if (!allDone) return;

    if (pollRef.current) clearInterval(pollRef.current);

    const completed = takeJobs.filter((j) => j.status === "COMPLETED");
    if (completed.length === 0) {
      toast.error("Todos os takes falharam.");
      setPhase("setup");
      return;
    }

    if (completed.length === 1 || takes.length === 1) {
      // Single take done — no merge needed
      setMergedVideoUrl(completed[0].outputVideoUrl!);
      setPhase("done");
      return;
    }

    // Multiple takes — merge
    setPhase("merging");
    const urls = completed.map((j) => j.outputVideoUrl!);
    setMerging(true);
    fetch("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrls: urls }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const e = await res.json();
          throw new Error(e.error ?? "Merge failed");
        }
        return res.json();
      })
      .then(({ url }) => {
        setMergedVideoUrl(url);
        setPhase("done");
      })
      .catch((err) => {
        toast.error(err.message);
        // Still show individual videos
        setMergedVideoUrl(completed[0].outputVideoUrl!);
        setPhase("done");
      })
      .finally(() => setMerging(false));
  }, [takeJobs, phase, takes.length]);

  // ── Submit ──

  const handleGenerate = async () => {
    if (!allTakesReady) {
      toast.error("Faça upload de todos os arquivos antes de gerar.");
      return;
    }

    const settings = control._formValues as SettingsData;

    setPhase("generating");

    // Create all jobs in parallel
    const results = await Promise.all(
      takes.map(async (take, i) => {
        try {
          const res = await fetch("/api/generate-kling", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              inputVideoUrl: take.videoFile!.url,
              inputImageUrl: take.imageFile!.url,
              aspectRatio: settings.aspectRatio,
              resolution: settings.resolution,
              maxDuration: 15,
              motionStrength: settings.motionStrength,
              identityStrength: settings.identityStrength,
              facePreserveStrength: settings.facePreserveStrength,
              backgroundMode: settings.backgroundMode,
            }),
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error ?? "Erro ao criar job");
          }

          const job = await res.json();
          return {
            takeIndex: i,
            jobId: job.id,
            status: "QUEUED",
            progress: 5,
            outputVideoUrl: null,
            errorMessage: null,
          } satisfies TakeJob;
        } catch (error) {
          return {
            takeIndex: i,
            jobId: `failed-${i}`,
            status: "FAILED",
            progress: 0,
            outputVideoUrl: null,
            errorMessage:
              error instanceof Error ? error.message : "Erro desconhecido",
          } satisfies TakeJob;
        }
      })
    );

    setTakeJobs(results);
    toast.success(`${results.filter((r) => r.status !== "FAILED").length} takes em processamento!`);
  };

  // ─── Render ───

  if (phase === "done") {
    const completedJobs = takeJobs.filter((j) => j.status === "COMPLETED" && j.outputVideoUrl);
    const isMerged = mergedVideoUrl && completedJobs.length > 1 && mergedVideoUrl !== completedJobs[0]?.outputVideoUrl;

    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Takes Concluídos</h1>
          <p className="text-white/50 mt-1">
            {isMerged
              ? `${completedJobs.length} takes mesclados com sucesso`
              : completedJobs.length > 1
              ? `${completedJobs.length} takes gerados — download individual disponível`
              : "Take gerado com sucesso"}
          </p>
        </div>

        {/* Primary video */}
        {mergedVideoUrl && (
          <Card className="bg-white/[0.03] border-white/[0.08]">
            <CardContent className="pt-6">
              <video
                src={mergedVideoUrl}
                controls
                className="w-full rounded-lg aspect-video bg-black"
              />
            </CardContent>
          </Card>
        )}

        {/* Individual takes when merge is not available */}
        {!isMerged && completedJobs.length > 1 && (
          <div className="space-y-3">
            <p className="text-xs text-white/40 uppercase tracking-wider">Vídeos individuais</p>
            {completedJobs.map((job) => (
              <Card key={job.jobId} className="bg-white/[0.03] border-white/[0.08]">
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-white/70">Take {job.takeIndex + 1}</span>
                    <a href={job.outputVideoUrl!} download>
                      <Button variant="outline" className="h-7 text-xs border-white/10 text-white/60 hover:bg-white/5">
                        <Download className="w-3 h-3 mr-1" />
                        Baixar
                      </Button>
                    </a>
                  </div>
                  <video src={job.outputVideoUrl!} controls className="w-full rounded-lg bg-black" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          {mergedVideoUrl && (
            <a href={mergedVideoUrl} download className="flex-1">
              <Button variant="outline" className="w-full border-white/10 text-white hover:bg-white/5">
                <Download className="w-4 h-4 mr-2" />
                Baixar {isMerged ? "Vídeo Final" : "Take 1"}
              </Button>
            </a>
          )}
          <Button
            onClick={() => {
              setPhase("setup");
              setTakeJobs([]);
              setMergedVideoUrl(null);
              setTakes([
                { id: crypto.randomUUID(), imageFile: null, videoFile: null },
                { id: crypto.randomUUID(), imageFile: null, videoFile: null },
              ]);
            }}
            className="flex-1 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white"
          >
            Nova Geração
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "generating" || phase === "merging") {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Gerando Takes</h1>
          <p className="text-white/50 mt-1">
            {phase === "merging"
              ? "Mesclando vídeos..."
              : `Processando ${takes.length} take${takes.length > 1 ? "s" : ""} em paralelo`}
          </p>
        </div>

        {phase === "merging" && (
          <Card className="bg-white/[0.03] border-white/[0.08]">
            <CardContent className="pt-6 flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <span className="text-white/70">Mesclando todos os takes em um único vídeo...</span>
            </CardContent>
          </Card>
        )}

        <div className="space-y-3">
          {takeJobs.map((job) => (
            <GeneratingCard key={job.jobId} job={job} />
          ))}
        </div>
      </div>
    );
  }

  // Setup phase
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Multi-Take</h1>
        <p className="text-white/50 mt-1">
          Gere múltiplos takes em paralelo e combine em um único vídeo
        </p>
      </div>

      {/* Takes */}
      <div className="space-y-4">
        {takes.map((take, i) => (
          <TakeCard
            key={take.id}
            take={take}
            index={i}
            onUpdate={updateTake}
            onRemove={removeTake}
            canRemove={takes.length > 1}
          />
        ))}

        {takes.length < 8 && (
          <button
            type="button"
            onClick={addTake}
            className="w-full py-3 rounded-xl border border-dashed border-white/[0.12] text-white/40 hover:text-white/60 hover:border-white/20 transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" />
            Adicionar take ({takes.length}/8)
          </button>
        )}
      </div>

      {/* Settings */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader>
          <CardTitle className="text-white text-base">Configurações</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-white/70">Proporção</Label>
              <Controller
                name="aspectRatio"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="RATIO_16_9">16:9 — Paisagem</SelectItem>
                      <SelectItem value="RATIO_9_16">9:16 — Vertical</SelectItem>
                      <SelectItem value="RATIO_1_1">1:1 — Quadrado</SelectItem>
                      <SelectItem value="RATIO_4_3">4:3 — Clássico</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-white/70">Resolução</Label>
              <Controller
                name="resolution"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SD_480">480p (SD)</SelectItem>
                      <SelectItem value="HD_720">720p (HD)</SelectItem>
                      <SelectItem value="FHD_1080">1080p (Full HD)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full p-6 flex items-center justify-between text-left"
        >
          <span className="text-white font-medium text-base">
            Configurações Avançadas
          </span>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4 text-white/40" />
          ) : (
            <ChevronDown className="w-4 h-4 text-white/40" />
          )}
        </button>

        {showAdvanced && (
          <CardContent className="pt-0 space-y-4">
            <div className="space-y-2">
              <Label className="text-white/70">Modo de Fundo</Label>
              <Controller
                name="backgroundMode"
                control={control}
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="KEEP">Manter original</SelectItem>
                      <SelectItem value="REMOVE">Remover fundo</SelectItem>
                      <SelectItem value="BLUR">Desfocar fundo</SelectItem>
                      <SelectItem value="REPLACE">Substituir fundo</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </CardContent>
        )}
      </Card>

      {/* Credit estimate */}
      <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/[0.03] border border-white/[0.08]">
        <div className="text-sm text-white/50">
          Custo estimado total
          <span className="block text-xs text-white/30 mt-0.5">
            {takes.length} take{takes.length > 1 ? "s" : ""} · {creditsPerSecond} créditos/s
            {takes.some((t) => t.videoFile?.duration)
              ? ""
              : " — envie os vídeos para calcular"}
          </span>
        </div>
        <div className="text-right">
          {totalCredits > 0 ? (
            <>
              <span className="text-2xl font-bold text-violet-400">{totalCredits}</span>
              <span className="text-sm text-white/40 ml-1">créditos</span>
            </>
          ) : (
            <>
              <span className="text-2xl font-bold text-white/20">—</span>
            </>
          )}
        </div>
      </div>

      <Button
        type="button"
        onClick={handleGenerate}
        disabled={!allTakesReady}
        className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-12 text-base font-medium disabled:opacity-40"
      >
        <Sparkles className="w-5 h-5 mr-2" />
        {totalCredits > 0
          ? `Gerar ${takes.length} Takes · ${totalCredits} créditos`
          : `Gerar ${takes.length} Takes`}
      </Button>
    </div>
  );
}
