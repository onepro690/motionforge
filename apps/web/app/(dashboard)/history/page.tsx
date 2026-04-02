import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { Video, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { JobStatusBadge } from "@/components/jobs/status-badge";
import { formatRelativeTime } from "@/lib/utils";

interface SearchParams {
  status?: string;
  page?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

const PAGE_SIZE = 12;

export default async function HistoryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session!.user.id;
  const page = parseInt(params.page ?? "1");
  const status = params.status;

  const where = {
    userId,
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

  const statuses = [
    "QUEUED",
    "PROCESSING",
    "RENDERING",
    "COMPLETED",
    "FAILED",
  ];

  const statusLabels: Record<string, string> = {
    QUEUED: "Na Fila",
    PROCESSING: "Processando",
    RENDERING: "Renderizando",
    COMPLETED: "Concluídos",
    FAILED: "Falhas",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Histórico</h1>
          <p className="text-white/50 mt-1">{total} gerações no total</p>
        </div>
        <Link href="/generate">
          <Button className="bg-violet-600 hover:bg-violet-700 text-white">
            Nova Geração
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <Link href="/history">
          <Button
            variant={!status ? "default" : "ghost"}
            size="sm"
            className={
              !status
                ? "bg-violet-600 text-white"
                : "text-white/50 hover:text-white"
            }
          >
            Todos
          </Button>
        </Link>
        {statuses.map((s) => (
          <Link key={s} href={`/history?status=${s}`}>
            <Button
              variant={status === s ? "default" : "ghost"}
              size="sm"
              className={
                status === s
                  ? "bg-violet-600 text-white"
                  : "text-white/50 hover:text-white"
              }
            >
              {statusLabels[s]}
            </Button>
          </Link>
        ))}
      </div>

      {jobs.length === 0 ? (
        <div className="text-center py-20">
          <Video className="w-16 h-16 text-white/10 mx-auto mb-4" />
          <p className="text-white/40 mb-4">Nenhum job encontrado</p>
          <Link href="/generate">
            <Button className="bg-violet-600 hover:bg-violet-700 text-white">
              Criar geração
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {jobs.map((job) => (
            <Link href={`/jobs/${job.id}`} key={job.id}>
              <Card className="bg-white/[0.03] border-white/[0.08] hover:border-white/[0.15] transition-colors cursor-pointer group overflow-hidden">
                <div className="aspect-video bg-[#0d1117] flex items-center justify-center relative overflow-hidden">
                  {job.outputThumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={job.outputThumbnailUrl}
                      alt="Thumbnail"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <Video className="w-10 h-10 text-white/20" />
                  )}
                  {job.status === "COMPLETED" && job.outputVideoUrl && (
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                        <Download className="w-5 h-5 text-white" />
                      </div>
                    </div>
                  )}
                </div>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-white">
                        #{job.id.slice(-8)}
                      </p>
                      <p className="text-xs text-white/40 mt-0.5">
                        {formatRelativeTime(job.createdAt)}
                      </p>
                    </div>
                    <JobStatusBadge status={job.status} />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/history?page=${p}${status ? `&status=${status}` : ""}`}
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
