import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { Video, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/jobs/status-badge";
import { formatRelativeTime } from "@/lib/utils";
import { VideoCard } from "@/components/history/video-card";
import { ImageCard } from "@/components/history/image-card";

interface SearchParams {
  status?: string;
  page?: string;
  tab?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

const PAGE_SIZE = 12;

const statuses = ["QUEUED", "PROCESSING", "RENDERING", "COMPLETED", "FAILED"];
const statusLabels: Record<string, string> = {
  QUEUED: "Na Fila",
  PROCESSING: "Processando",
  RENDERING: "Renderizando",
  COMPLETED: "Concluídos",
  FAILED: "Falhas",
};

export default async function HistoryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session!.user.id;
  const page = parseInt(params.page ?? "1");
  const status = params.status;
  const tab = params.tab === "images" ? "images" : "videos";

  const isImages = tab === "images";

  const where = {
    userId,
    ...(isImages
      ? { provider: "nanobanana" }
      : { NOT: { provider: "nanobanana" } }),
    ...(status ? { status: status as "QUEUED" | "PROCESSING" | "RENDERING" | "COMPLETED" | "FAILED" } : {}),
  };

  const [jobs, total] = await Promise.all([
    prisma.generationJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.generationJob.count({ where }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const statusHref = (s?: string) =>
    s ? `/history?tab=${tab}&status=${s}` : `/history?tab=${tab}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Histórico</h1>
          <p className="text-white/50 mt-1">
            {total} {isImages ? "imagens" : "vídeos"} no total
          </p>
        </div>
        <Link href={isImages ? "/nanobanana" : "/generate"}>
          <Button className="bg-violet-600 hover:bg-violet-700 text-white">
            {isImages ? "Nova Imagem" : "Nova Geração"}
          </Button>
        </Link>
      </div>

      {/* Tabs: Vídeos | Imagens */}
      <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] border border-white/[0.06] w-fit">
        <Link href="/history?tab=videos">
          <button
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              !isImages
                ? "bg-violet-600 text-white shadow"
                : "text-white/50 hover:text-white"
            }`}
          >
            <Video className="w-4 h-4" />
            Vídeos
          </button>
        </Link>
        <Link href="/history?tab=images">
          <button
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              isImages
                ? "bg-violet-600 text-white shadow"
                : "text-white/50 hover:text-white"
            }`}
          >
            <ImageIcon className="w-4 h-4" />
            Imagens
          </button>
        </Link>
      </div>

      {/* Status filters — videos only */}
      {!isImages && (
        <div className="flex flex-wrap gap-2">
          <Link href={statusHref()}>
            <Button
              variant={!status ? "default" : "ghost"}
              size="sm"
              className={!status ? "bg-violet-600 text-white" : "text-white/50 hover:text-white"}
            >
              Todos
            </Button>
          </Link>
          {statuses.map((s) => (
            <Link key={s} href={statusHref(s)}>
              <Button
                variant={status === s ? "default" : "ghost"}
                size="sm"
                className={status === s ? "bg-violet-600 text-white" : "text-white/50 hover:text-white"}
              >
                {statusLabels[s]}
              </Button>
            </Link>
          ))}
        </div>
      )}

      {/* Empty state */}
      {jobs.length === 0 ? (
        <div className="text-center py-20">
          {isImages ? (
            <ImageIcon className="w-16 h-16 text-white/10 mx-auto mb-4" />
          ) : (
            <Video className="w-16 h-16 text-white/10 mx-auto mb-4" />
          )}
          <p className="text-white/40 mb-4">
            {isImages ? "Nenhuma imagem gerada ainda" : "Nenhum vídeo encontrado"}
          </p>
          <Link href={isImages ? "/nanobanana" : "/generate"}>
            <Button className="bg-violet-600 hover:bg-violet-700 text-white">
              {isImages ? "Gerar imagem" : "Criar geração"}
            </Button>
          </Link>
        </div>
      ) : isImages ? (
        /* ── Images grid ── */
        <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {jobs.map((job) => (
            <ImageCard key={job.id} job={job} />
          ))}
        </div>
      ) : (
        /* ── Videos grid ── */
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.map((job) => (
            <VideoCard key={job.id} job={job} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/history?tab=${tab}&page=${p}${status ? `&status=${status}` : ""}`}
            >
              <Button
                variant={page === p ? "default" : "ghost"}
                size="sm"
                className={
                  page === p
                    ? "bg-violet-600 text-white w-8 h-8 p-0"
                    : "text-white/50 hover:text-white w-8 h-8 p-0"
                }
              >
                {p}
              </Button>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
