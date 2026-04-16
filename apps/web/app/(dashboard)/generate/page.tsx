"use client";
import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Loader2, Sparkles, ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { FileUpload, type UploadedFile } from "@/components/upload/file-upload";
import { VideoTrimmer } from "@/components/video-trimmer";
import { mergeVideosClient } from "@/lib/merge-videos";

type KlingModel    = "kling-3.0" | "kling-2.6";
type AspectRatio   = "RATIO_16_9" | "RATIO_9_16" | "RATIO_1_1" | "RATIO_4_3";
type Resolution    = "SD_480" | "HD_720" | "FHD_1080";
type BgMode        = "KEEP" | "REMOVE" | "BLUR" | "REPLACE";

interface Scene {
  id: string;
  videoFile: UploadedFile | null;
  imageFile: UploadedFile | null;
  trimStart: number;
  trimEnd: number;
}

const CREDITS_PER_SECOND: Record<Resolution, number> = {
  SD_480: 16,
  HD_720: 16,
  FHD_1080: 32,
};

// ─── SceneCard (has its own videoRef) ─────────────────────────────────────────

interface SceneCardProps {
  scene: Scene;
  index: number;
  showRemove: boolean;
  onRemove: () => void;
  onVideoChange: (f: UploadedFile | null) => void;
  onImageChange: (f: UploadedFile | null) => void;
  onTrimChange: (start: number, end: number) => void;
}

function SceneCard({
  scene, index, showRemove,
  onRemove, onVideoChange, onImageChange, onTrimChange,
}: SceneCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dur = scene.videoFile?.duration ?? 0;

  return (
    <Card className="bg-white/[0.03] border-white/[0.08]">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-white text-base">Cena {index + 1}</CardTitle>
          {showRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="w-7 h-7 rounded flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Vídeo de Movimento */}
        <div>
          <Label className="text-white/50 text-xs mb-2 block">Vídeo de Movimento</Label>
          <FileUpload
            icon="video"
            accept="video/mp4,video/quicktime,video/webm"
            maxSize={500 * 1024 * 1024}
            label="Arraste ou clique para enviar o vídeo"
            hint="MP4, MOV ou WebM • 3s–30s recomendado"
            value={scene.videoFile}
            onChange={onVideoChange}
          />

          {/* Preview + Trimmer — aparece depois do upload */}
          {scene.videoFile && dur > 0 && (
            <div className="mt-3 space-y-2">
              <video
                ref={videoRef}
                src={scene.videoFile.url}
                controls
                playsInline
                muted
                className="w-full rounded-lg max-h-52 object-contain bg-black"
              />
              <VideoTrimmer
                duration={dur}
                trimStart={scene.trimStart}
                trimEnd={scene.trimEnd}
                videoRef={videoRef}
                onChange={onTrimChange}
              />
            </div>
          )}
        </div>

        {/* Imagem do Avatar */}
        <div>
          <Label className="text-white/50 text-xs mb-2 block">Imagem do Avatar</Label>
          <FileUpload
            icon="image"
            accept="image/png,image/jpeg,image/webp"
            maxSize={50 * 1024 * 1024}
            label="Imagem do avatar"
            hint="PNG, JPG ou WebP"
            value={scene.imageFile}
            onChange={onImageChange}
            supportsPaste
          />
        </div>

      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GeneratePage() {
  const router = useRouter();

  const [scenes, setScenes] = useState<Scene[]>([
    { id: "1", videoFile: null, imageFile: null, trimStart: 0, trimEnd: 0 },
  ]);
  const [loading, setLoading]           = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("Criando...");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Settings via useState (Select controlado simples, sem react-hook-form) ──
  const [klingModel,    setKlingModel]    = useState<KlingModel>("kling-3.0");
  const [aspectRatio,   setAspectRatio]   = useState<AspectRatio>("RATIO_9_16");
  const [resolution,    setResolution]    = useState<Resolution>("HD_720");
  const [backgroundMode, setBgMode]       = useState<BgMode>("KEEP");

  const creditsPerSecond = CREDITS_PER_SECOND[resolution];

  const filledScenes = scenes.filter((s) => s.videoFile && s.imageFile);

  const totalCredits = filledScenes.length > 0
    ? filledScenes.reduce((sum, s) => {
        const dur     = s.videoFile!.duration ?? 0;
        const trimmed = Math.max(0, dur - s.trimStart - s.trimEnd);
        return sum + Math.ceil(trimmed * creditsPerSecond);
      }, 0)
    : null;

  // ── Scene helpers ────────────────────────────────────────────────────────────

  const addScene = () =>
    setScenes((prev) => [
      ...prev,
      { id: `${Date.now()}`, videoFile: null, imageFile: null, trimStart: 0, trimEnd: 0 },
    ]);

  const removeScene = (id: string) =>
    setScenes((prev) => prev.filter((s) => s.id !== id));

  const updateScene = useCallback((id: string, update: Partial<Scene>) =>
    setScenes((prev) => prev.map((s) => s.id === id ? { ...s, ...update } : s)), []);

  // ── Trim + re-upload (se necessário) ────────────────────────────────────────

  async function trimAndUpload(scene: Scene): Promise<string> {
    const { trimStart, trimEnd, videoFile } = scene;
    if (!videoFile) throw new Error("Sem vídeo");
    if (trimStart === 0 && trimEnd === 0) return videoFile.url;

    setLoadingLabel("Baixando vídeo de referência...");
    const resp = await fetch(`/api/proxy-video?url=${encodeURIComponent(videoFile.url)}`);
    if (!resp.ok) throw new Error("Falha ao baixar vídeo para corte");
    const blob = await resp.blob();
    const file = new File([blob], "motion.mp4", { type: blob.type || "video/mp4" });

    setLoadingLabel("Cortando vídeo...");
    const trimmed = await mergeVideosClient(
      [file],
      (_pct, label) => setLoadingLabel(`Cortando: ${label}`),
      [{ start: trimStart, end: trimEnd }]
    );

    setLoadingLabel("Enviando vídeo cortado...");
    const uploaded = await upload("trimmed-motion.mp4", trimmed, {
      access: "public",
      handleUploadUrl: "/api/upload",
      clientPayload: "input_video",
    });
    return uploaded.url;
  }

  // ── Submit ───────────────────────────────────────────────────────────────────

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (filledScenes.length === 0) {
      toast.error("Preencha pelo menos uma cena com vídeo e imagem");
      return;
    }

    setLoading(true);
    try {
      // Cortar vídeos que precisam de trim
      const hasTrim = filledScenes.some((s) => s.trimStart > 0 || s.trimEnd > 0);
      if (hasTrim) setLoadingLabel("Preparando vídeos...");

      const videoUrls = await Promise.all(filledScenes.map(trimAndUpload));

      setLoadingLabel("Criando jobs...");

      const results = await Promise.allSettled(
        filledScenes.map((scene, i) =>
          fetch("/api/generate-kling", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              inputVideoUrl: videoUrls[i],
              inputImageUrl: scene.imageFile!.url,
              klingModel,
              aspectRatio,
              resolution,
              backgroundMode,
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const err = await res.json() as { error?: string };
              throw new Error(err.error ?? "Erro ao criar job");
            }
            return res.json() as Promise<{ id: string }>;
          })
        )
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed    = results.filter((r) => r.status === "rejected").length;

      if (succeeded === 0) { toast.error("Falha ao criar todos os jobs"); return; }
      if (failed > 0) toast.warning(`${succeeded} job(s) criado(s), ${failed} falhou`);
      else toast.success(`${succeeded} geração${succeeded > 1 ? "ões" : ""} iniciada${succeeded > 1 ? "s" : ""}!`);

      if (succeeded === 1) {
        const first = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
        router.push(`/jobs/${first.value.id}`);
      } else {
        router.push("/history");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao criar job");
    } finally {
      setLoading(false);
      setLoadingLabel("Criando...");
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Motion Control</h1>
        <p className="text-white/50 mt-1">Aplique movimentos de referência a imagens avatar</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">

        {/* Scenes */}
        <div className="space-y-4">
          {scenes.map((scene, i) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              index={i}
              showRemove={scenes.length > 1}
              onRemove={() => removeScene(scene.id)}
              onVideoChange={(f) => updateScene(scene.id, { videoFile: f, trimStart: 0, trimEnd: 0 })}
              onImageChange={(f) => updateScene(scene.id, { imageFile: f })}
              onTrimChange={(start, end) => updateScene(scene.id, { trimStart: start, trimEnd: end })}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={addScene}
            className="w-full border-dashed border-white/10 text-white/40 hover:text-white hover:bg-white/5 hover:border-white/20 h-10 text-sm"
          >
            <Plus className="w-4 h-4 mr-2" />
            Adicionar Cena
          </Button>
        </div>

        {/* Configurações */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardHeader>
            <CardTitle className="text-white text-base">Configurações</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">

            <div className="space-y-2">
              <Label className="text-white/70">Modelo Kling</Label>
              <Select value={klingModel} onValueChange={(v) => setKlingModel(v as KlingModel)}>
                <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="kling-3.0">Kling 3.0 (mais recente)</SelectItem>
                  <SelectItem value="kling-2.6">Kling 2.6 Standard</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/70">Proporção</Label>
                <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v as AspectRatio)}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RATIO_16_9">16:9 — Paisagem</SelectItem>
                    <SelectItem value="RATIO_9_16">9:16 — Vertical</SelectItem>
                    <SelectItem value="RATIO_1_1">1:1 — Quadrado</SelectItem>
                    <SelectItem value="RATIO_4_3">4:3 — Clássico</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-white/70">Resolução</Label>
                <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SD_480">480p (SD)</SelectItem>
                    <SelectItem value="HD_720">720p (HD)</SelectItem>
                    <SelectItem value="FHD_1080">1080p (Full HD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-start gap-3 px-3 py-2.5 rounded-md bg-white/[0.03] border border-white/[0.08]">
              <span className="text-white/30 text-sm mt-0.5">⏱</span>
              <div>
                <p className="text-sm text-white/60">Duração do vídeo gerado</p>
                <p className="text-xs text-white/30 mt-0.5">Igual ao vídeo de referência de cada cena (após corte)</p>
              </div>
            </div>

          </CardContent>
        </Card>

        {/* Configurações Avançadas */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full p-6 flex items-center justify-between text-left"
          >
            <span className="text-white font-medium text-base">Configurações Avançadas</span>
            {showAdvanced
              ? <ChevronUp className="w-4 h-4 text-white/40" />
              : <ChevronDown className="w-4 h-4 text-white/40" />}
          </button>
          {showAdvanced && (
            <CardContent className="pt-0 space-y-6">
              <div className="space-y-2">
                <Label className="text-white/70">Modo de Fundo</Label>
                <Select value={backgroundMode} onValueChange={(v) => setBgMode(v as BgMode)}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="KEEP">Manter original</SelectItem>
                    <SelectItem value="REMOVE">Remover fundo</SelectItem>
                    <SelectItem value="BLUR">Desfocar fundo</SelectItem>
                    <SelectItem value="REPLACE">Substituir fundo</SelectItem>
                  </SelectContent>
                </Select>
                {klingModel === "kling-2.6" && (
                  <p className="text-[11px] text-white/30 mt-1">Não disponível no Kling 2.6 Standard</p>
                )}
              </div>
            </CardContent>
          )}
        </Card>

        {/* Custo estimado */}
        <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-white/[0.03] border border-white/[0.08]">
          <div className="text-sm text-white/50">
            Custo estimado
            <span className="block text-xs text-white/30 mt-0.5">
              {resolution === "FHD_1080" ? "1080p (pro)" : resolution === "HD_720" ? "720p (std)" : "480p (std)"}
              {filledScenes.length > 0
                ? ` · ${filledScenes.length} cena${filledScenes.length > 1 ? "s" : ""} × ${creditsPerSecond} créditos/s`
                : ` · ${creditsPerSecond} créditos/s`}
            </span>
          </div>
          <div className="text-right">
            {totalCredits !== null ? (
              <>
                <span className="text-2xl font-bold text-violet-400">{totalCredits}</span>
                <span className="text-sm text-white/40 ml-1">créditos</span>
              </>
            ) : (
              <>
                <span className="text-2xl font-bold text-white/20">{creditsPerSecond}</span>
                <span className="text-sm text-white/20 ml-1">créditos/s</span>
              </>
            )}
          </div>
        </div>

        <Button
          type="submit"
          disabled={loading || filledScenes.length === 0}
          className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-12 text-base font-medium"
        >
          {loading
            ? <Loader2 className="w-5 h-5 animate-spin mr-2" />
            : <Sparkles className="w-5 h-5 mr-2" />}
          {loading
            ? loadingLabel
            : totalCredits !== null
              ? `Gerar ${filledScenes.length} Vídeo${filledScenes.length > 1 ? "s" : ""} · ${totalCredits} créditos`
              : "Gerar Vídeo"}
        </Button>

      </form>
    </div>
  );
}
