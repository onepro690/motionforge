import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  AlertCircle,
  Video,
  ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { JobStatusBadge } from "@/components/jobs/status-badge";
import { JobStatusPoller } from "@/components/jobs/status-poller";
import { CancelButton } from "@/components/jobs/cancel-button";
import { formatRelativeTime, getStatusLabel } from "@/lib/utils";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session!.user.id;

  const job = await prisma.generationJob.findFirst({
    where: { id, userId },
  });

  if (!job) notFound();

  const isActive = ["QUEUED", "PROCESSING", "RENDERING"].includes(job.status);

  const statusSteps = [
    { key: "QUEUED", label: "Na Fila", desc: "Job aguardando processamento" },
    {
      key: "PROCESSING",
      label: "Processando",
      desc: "Pré-processamento e validação",
    },
    {
      key: "RENDERING",
      label: "Renderizando",
      desc: "Inferência de IA em andamento",
    },
    {
      key: "COMPLETED",
      label: "Concluído",
      desc: "Vídeo gerado com sucesso",
    },
  ];

  const statusOrder = ["QUEUED", "PROCESSING", "RENDERING", "COMPLETED"];
  const currentStep =
    job.status === "FAILED"
      ? statusOrder.indexOf("RENDERING")
      : statusOrder.indexOf(job.status);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/history">
          <Button
            variant="ghost"
            size="sm"
            className="text-white/50 hover:text-white gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white">
              Job #{job.id.slice(-8)}
            </h1>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="text-white/40 text-sm mt-0.5">
            Criado {formatRelativeTime(job.createdAt)}
          </p>
        </div>
        {isActive && (
          <div className="flex items-center gap-2">
            <JobStatusPoller jobId={job.id} initialStatus={job.status} />
            <CancelButton jobId={job.id} />
          </div>
        )}
      </div>

      {/* Status Timeline */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader>
          <CardTitle className="text-white text-base">Progresso</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <div className="absolute left-4 top-8 bottom-4 w-px bg-white/[0.08]" />
            <div className="space-y-6">
              {statusSteps.map((step, i) => {
                const isDone =
                  i < currentStep || job.status === "COMPLETED";
                const isCurrent =
                  i === currentStep &&
                  job.status !== "COMPLETED" &&
                  job.status !== "FAILED";
                const isFailed =
                  job.status === "FAILED" && i === currentStep;

                return (
                  <div key={step.key} className="flex gap-4 items-start">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 z-10 ${
                        isDone
                          ? "bg-green-500/20 border border-green-500/50"
                          : isCurrent
                          ? "bg-violet-500/20 border border-violet-500/50 animate-pulse"
                          : isFailed
                          ? "bg-red-500/20 border border-red-500/50"
                          : "bg-white/[0.03] border border-white/[0.08]"
                      }`}
                    >
                      <div
                        className={`w-2 h-2 rounded-full ${
                          isDone
                            ? "bg-green-400"
                            : isCurrent
                            ? "bg-violet-400"
                            : isFailed
                            ? "bg-red-400"
                            : "bg-white/20"
                        }`}
                      />
                    </div>
                    <div className="pt-1">
                      <p
                        className={`text-sm font-medium ${
                          isDone || isCurrent ? "text-white" : "text-white/40"
                        }`}
                      >
                        {step.label}
                      </p>
                      <p className="text-xs text-white/30 mt-0.5">
                        {step.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {job.status === "FAILED" && job.errorMessage && (
            <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex gap-3">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-300 font-medium">
                  Erro no processamento
                </p>
                <p className="text-xs text-red-300/70 mt-1">
                  {job.errorMessage}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Inputs */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardHeader>
            <CardTitle className="text-white text-base">Entradas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs text-white/40 uppercase tracking-wider flex items-center gap-2">
                <Video className="w-3 h-3" /> Vídeo de Movimento
              </p>
              <div className="aspect-video rounded-lg bg-white/[0.03] border border-white/[0.06] overflow-hidden">
                <video
                  src={job.inputVideoUrl}
                  controls
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-white/40 uppercase tracking-wider flex items-center gap-2">
                <ImageIcon className="w-3 h-3" /> Imagem do Avatar
              </p>
              <div className="w-32 aspect-square rounded-lg bg-white/[0.03] border border-white/[0.06] overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={job.inputImageUrl}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Output */}
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-white text-base">Resultado</CardTitle>
            {job.status === "COMPLETED" && job.outputVideoUrl && (
              <a href={job.outputVideoUrl} download>
                <Button
                  size="sm"
                  className="bg-violet-600 hover:bg-violet-700 text-white gap-2 h-8 text-xs"
                >
                  <Download className="w-3 h-3" /> Download
                </Button>
              </a>
            )}
          </CardHeader>
          <CardContent>
            {job.status === "COMPLETED" && job.outputVideoUrl ? (
              <div className="aspect-video rounded-lg overflow-hidden bg-black">
                <video
                  src={job.outputVideoUrl}
                  controls
                  poster={job.outputThumbnailUrl ?? undefined}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <div className="aspect-video rounded-lg bg-white/[0.02] border border-white/[0.06] flex flex-col items-center justify-center gap-3">
                {isActive ? (
                  <>
                    <div className="w-10 h-10 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
                    <p className="text-sm text-white/50">
                      {getStatusLabel(job.status)}...
                    </p>
                  </>
                ) : job.status === "FAILED" ? (
                  <>
                    <AlertCircle className="w-10 h-10 text-red-400" />
                    <p className="text-sm text-red-300">Geração falhou</p>
                    <form
                      action={`/api/jobs/${job.id}/retry`}
                      method="POST"
                    >
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="gap-2 border-red-500/30 text-red-300 hover:bg-red-500/10"
                      >
                        <RefreshCw className="w-3 h-3" /> Tentar novamente
                      </Button>
                    </form>
                  </>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Metadata */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader>
          <CardTitle className="text-white text-base">Metadados</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Provider", value: job.provider },
              {
                label: "Proporção",
                value: job.aspectRatio
                  .replace("RATIO_", "")
                  .replace("_", ":"),
              },
              {
                label: "Resolução",
                value: job.resolution.replace("_", " "),
              },
              { label: "Duração máx.", value: `${job.maxDuration}s` },
              {
                label: "Força de movimento",
                value: `${(job.motionStrength * 100).toFixed(0)}%`,
              },
              {
                label: "Identidade",
                value: `${(job.identityStrength * 100).toFixed(0)}%`,
              },
              {
                label: "Preservação facial",
                value: `${(job.facePreserveStrength * 100).toFixed(0)}%`,
              },
              { label: "Fundo", value: job.backgroundMode },
            ].map((item) => (
              <div
                key={item.label}
                className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]"
              >
                <p className="text-xs text-white/40 mb-1">{item.label}</p>
                <p className="text-sm text-white font-medium">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
