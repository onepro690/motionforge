"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Video, Download, Play, Trash2, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { JobStatusBadge } from "@/components/jobs/status-badge";
import { formatRelativeTime } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface Job {
  id: string;
  status: string;
  provider: string;
  outputVideoUrl: string | null;
  outputThumbnailUrl: string | null;
  inputImageUrl: string;
  promptText: string | null;
  createdAt: Date;
}

interface VideoCardProps {
  job: Job;
}

export function VideoCard({ job }: VideoCardProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Falha ao apagar");
      toast.success("Vídeo apagado");
      router.refresh();
    } catch {
      toast.error("Erro ao apagar vídeo");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // Best thumbnail: output thumb → input image → nothing
  const thumbSrc = job.outputThumbnailUrl ?? job.inputImageUrl ?? null;
  const hasVideo = job.status === "COMPLETED" && !!job.outputVideoUrl;

  const handleMouseEnter = () => {
    setIsHovering(true);
    if (hasVideo && videoRef.current) {
      videoRef.current.currentTime = 0;
      void videoRef.current.play().catch(() => {/* ignore */});
    }
  };

  const handleMouseLeave = () => {
    setIsHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  return (
    <Link href={`/jobs/${job.id}`}>
      <Card
        className="bg-white/[0.03] border-white/[0.08] hover:border-white/[0.15] transition-colors cursor-pointer group overflow-hidden"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Thumbnail area */}
        <div className="aspect-video bg-[#0d1117] flex items-center justify-center relative overflow-hidden">

          {/* Static thumbnail (always rendered) */}
          {thumbSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbSrc}
              alt="Thumbnail"
              className={`w-full h-full object-cover transition-all duration-300 ${
                isHovering && hasVideo ? "opacity-0" : "group-hover:scale-105"
              }`}
            />
          ) : (
            <Video className="w-10 h-10 text-white/20" />
          )}

          {/* Video preview on hover — only for completed jobs */}
          {hasVideo && (
            <video
              ref={videoRef}
              src={job.outputVideoUrl!}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${
                isHovering ? "opacity-100" : "opacity-0"
              }`}
              muted
              loop
              playsInline
              preload="none"
            />
          )}

          {/* Overlay */}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            {hasVideo ? (
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <Play className="w-5 h-5 text-white fill-white" />
              </div>
            ) : job.status === "COMPLETED" ? (
              <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <Download className="w-5 h-5 text-white" />
              </div>
            ) : null}
          </div>

          {/* Badge: Juntado */}
          {job.provider === "merged" && (
            <div className="absolute top-2 left-2">
              <span className="text-[10px] bg-violet-500/80 text-white px-1.5 py-0.5 rounded font-medium backdrop-blur-sm">
                Juntado
              </span>
            </div>
          )}
        </div>

        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">
                #{job.id.slice(-8)}
              </p>
              {job.promptText && (
                <p className="text-xs text-white/40 truncate mt-0.5">
                  {job.promptText}
                </p>
              )}
              <p className="text-xs text-white/30 mt-0.5">
                {formatRelativeTime(job.createdAt)}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <JobStatusBadge status={job.status} />
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-all ${
                  confirmDelete
                    ? "bg-red-500/20 text-red-400 border border-red-500/40"
                    : "text-white/25 hover:text-red-400 hover:bg-red-500/10"
                }`}
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {confirmDelete && <span>Confirmar</span>}
              </button>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
