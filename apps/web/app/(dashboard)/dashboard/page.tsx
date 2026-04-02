import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { Plus, Video, CheckCircle, Clock, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JobStatusBadge } from "@/components/jobs/status-badge";
import { formatRelativeTime } from "@/lib/utils";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session!.user.id;

  const [totalJobs, completedJobs, processingJobs, failedJobs, recentJobs] =
    await Promise.all([
      prisma.generationJob.count({ where: { userId } }),
      prisma.generationJob.count({ where: { userId, status: "COMPLETED" } }),
      prisma.generationJob.count({
        where: {
          userId,
          status: { in: ["QUEUED", "PROCESSING", "RENDERING"] },
        },
      }),
      prisma.generationJob.count({ where: { userId, status: "FAILED" } }),
      prisma.generationJob.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
    ]);

  const stats = [
    { label: "Total de Jobs", value: totalJobs, icon: Video, color: "violet" },
    {
      label: "Concluídos",
      value: completedJobs,
      icon: CheckCircle,
      color: "green",
    },
    {
      label: "Em Processamento",
      value: processingJobs,
      icon: Clock,
      color: "blue",
    },
    { label: "Falhas", value: failedJobs, icon: AlertCircle, color: "red" },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-white/50 mt-1">
            Bem-vindo de volta, {session!.user.name ?? "usuário"}
          </p>
        </div>
        <Link href="/generate">
          <Button className="bg-violet-600 hover:bg-violet-700 text-white gap-2">
            <Plus className="w-4 h-4" /> Nova Geração
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card
            key={stat.label}
            className="bg-white/[0.03] border-white/[0.08]"
          >
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-white/50">{stat.label}</p>
                <stat.icon
                  className={`w-4 h-4 ${
                    stat.color === "violet"
                      ? "text-violet-400"
                      : stat.color === "green"
                      ? "text-green-400"
                      : stat.color === "blue"
                      ? "text-blue-400"
                      : "text-red-400"
                  }`}
                />
              </div>
              <p className="text-3xl font-bold text-white">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Jobs */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-white text-lg">Jobs Recentes</CardTitle>
          <Link href="/history">
            <Button
              variant="ghost"
              size="sm"
              className="text-white/50 hover:text-white text-xs"
            >
              Ver todos
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {recentJobs.length === 0 ? (
            <div className="text-center py-12">
              <Video className="w-12 h-12 text-white/20 mx-auto mb-4" />
              <p className="text-white/40 mb-4">Nenhum job criado ainda</p>
              <Link href="/generate">
                <Button className="bg-violet-600 hover:bg-violet-700 text-white">
                  Criar primeira geração
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentJobs.map((job) => (
                <Link href={`/jobs/${job.id}`} key={job.id}>
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:border-white/[0.12] transition-colors cursor-pointer">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                        <Video className="w-5 h-5 text-violet-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">
                          Job #{job.id.slice(-8)}
                        </p>
                        <p className="text-xs text-white/40">
                          {formatRelativeTime(job.createdAt)}
                        </p>
                      </div>
                    </div>
                    <JobStatusBadge status={job.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
