"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
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

const generateSchema = z.object({
  aspectRatio: z.enum([
    "RATIO_16_9",
    "RATIO_9_16",
    "RATIO_1_1",
    "RATIO_4_3",
  ]),
  resolution: z.enum(["SD_480", "HD_720", "FHD_1080"]),
  maxDuration: z.number().min(3).max(30),
  motionStrength: z.number().min(0).max(1),
  identityStrength: z.number().min(0).max(1),
  facePreserveStrength: z.number().min(0).max(1),
  backgroundMode: z.enum(["KEEP", "REMOVE", "BLUR", "REPLACE"]),
});

type GenerateFormData = z.infer<typeof generateSchema>;

export default function GeneratePage() {
  const router = useRouter();
  const [videoFile, setVideoFile] = useState<UploadedFile | null>(null);
  const [imageFile, setImageFile] = useState<UploadedFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { control, handleSubmit } = useForm<GenerateFormData>({
    resolver: zodResolver(generateSchema),
    defaultValues: {
      aspectRatio: "RATIO_16_9",
      resolution: "HD_720",
      maxDuration: 15,
      motionStrength: 0.8,
      identityStrength: 0.9,
      facePreserveStrength: 0.85,
      backgroundMode: "KEEP",
    },
  });

  const onSubmit = async (data: GenerateFormData) => {
    if (!videoFile || !imageFile) {
      toast.error("Envie o vídeo de movimento e a imagem do avatar");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputVideoUrl: videoFile.url,
          inputImageUrl: imageFile.url,
          ...data,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error ?? "Erro ao criar job");
      }

      const { id } = await response.json();
      toast.success("Geração iniciada! Acompanhe o progresso.");
      router.push(`/jobs/${id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Erro ao criar job"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Nova Geração</h1>
        <p className="text-white/50 mt-1">
          Faça upload dos arquivos e configure sua geração
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Uploads */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardHeader>
            <CardTitle className="text-white text-base">
              Arquivos de Entrada
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <Label className="text-white/70 mb-3 block">
                Vídeo de Movimento
              </Label>
              <FileUpload
                icon="video"
                accept="video/mp4,video/quicktime,video/webm"
                maxSize={500 * 1024 * 1024}
                label="Arraste ou clique para enviar o vídeo"
                hint="MP4, MOV ou WebM • 3s–30s recomendado"
                value={videoFile}
                onChange={setVideoFile}
              />
            </div>

            <div>
              <Label className="text-white/70 mb-3 block">
                Imagem do Avatar
              </Label>
              <FileUpload
                icon="image"
                accept="image/png,image/jpeg,image/webp"
                maxSize={50 * 1024 * 1024}
                label="Arraste ou clique para enviar a imagem"
                hint="PNG, JPG ou WebP • Rosto visível e nítido"
                value={imageFile}
                onChange={setImageFile}
              />
            </div>
          </CardContent>
        </Card>

        {/* Basic Config */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardHeader>
            <CardTitle className="text-white text-base">
              Configurações
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/70">Proporção</Label>
                <Controller
                  name="aspectRatio"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RATIO_16_9">
                          16:9 (Paisagem)
                        </SelectItem>
                        <SelectItem value="RATIO_9_16">
                          9:16 (Retrato)
                        </SelectItem>
                        <SelectItem value="RATIO_1_1">
                          1:1 (Quadrado)
                        </SelectItem>
                        <SelectItem value="RATIO_4_3">
                          4:3 (Clássico)
                        </SelectItem>
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
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SD_480">480p (SD)</SelectItem>
                        <SelectItem value="HD_720">720p (HD)</SelectItem>
                        <SelectItem value="FHD_1080">
                          1080p (Full HD)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            <Controller
              name="maxDuration"
              control={control}
              render={({ field }) => (
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <Label className="text-white/70">Duração máxima</Label>
                    <span className="text-sm text-violet-400 font-medium">
                      {field.value}s
                    </span>
                  </div>
                  <Slider
                    min={3}
                    max={30}
                    step={1}
                    value={[field.value]}
                    onValueChange={([v]) => field.onChange(v)}
                  />
                </div>
              )}
            />
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
            <CardContent className="pt-0 space-y-6">
              {[
                {
                  name: "motionStrength" as const,
                  label: "Força do Movimento",
                  hint: "Intensidade do movimento aplicado",
                },
                {
                  name: "identityStrength" as const,
                  label: "Preservação de Identidade",
                  hint: "Quanto da identidade original preservar",
                },
                {
                  name: "facePreserveStrength" as const,
                  label: "Preservação Facial",
                  hint: "Fidelidade ao rosto da imagem",
                },
              ].map((item) => (
                <Controller
                  key={item.name}
                  name={item.name}
                  control={control}
                  render={({ field }) => (
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <div>
                          <Label className="text-white/70">{item.label}</Label>
                          <p className="text-xs text-white/30 mt-0.5">
                            {item.hint}
                          </p>
                        </div>
                        <span className="text-sm text-violet-400 font-medium">
                          {(field.value * 100).toFixed(0)}%
                        </span>
                      </div>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[field.value]}
                        onValueChange={([v]) => field.onChange(v)}
                      />
                    </div>
                  )}
                />
              ))}

              <div className="space-y-2">
                <Label className="text-white/70">Modo de Fundo</Label>
                <Controller
                  name="backgroundMode"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="KEEP">Manter original</SelectItem>
                        <SelectItem value="REMOVE">Remover fundo</SelectItem>
                        <SelectItem value="BLUR">Desfocar fundo</SelectItem>
                        <SelectItem value="REPLACE">
                          Substituir fundo
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </CardContent>
          )}
        </Card>

        <Button
          type="submit"
          disabled={loading || !videoFile || !imageFile}
          className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-12 text-base font-medium"
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
          ) : (
            <Sparkles className="w-5 h-5 mr-2" />
          )}
          {loading ? "Criando job..." : "Gerar Vídeo"}
        </Button>
      </form>
    </div>
  );
}
