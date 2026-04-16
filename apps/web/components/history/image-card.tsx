"use client";

import { useState } from "react";
import { Download, Loader2, Image as ImageIcon, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/utils";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface Job {
  id: string;
  outputThumbnailUrl: string | null;
  promptText: string | null;
  createdAt: Date;
}

export function ImageCard({ job }: { job: Job }) {
  const router = useRouter();
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Falha ao apagar");
      toast.success("Imagem apagada");
      router.refresh();
    } catch {
      toast.error("Erro ao apagar imagem");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!job.outputThumbnailUrl || downloading) return;

    setDownloading(true);
    try {
      const res = await fetch(`/api/proxy-video?url=${encodeURIComponent(job.outputThumbnailUrl)}`);
      if (!res.ok) throw new Error("Falha ao baixar");
      const blob = await res.blob();
      const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `imagem-${job.id.slice(-8)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Erro ao baixar imagem");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="bg-white/[0.03] border-white/[0.08] overflow-hidden group">
      <div className="aspect-[9/16] bg-[#0d1117] flex items-center justify-center relative overflow-hidden">
        {job.outputThumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={job.outputThumbnailUrl}
            alt="Imagem gerada"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <ImageIcon className="w-10 h-10 text-white/20" />
        )}
        {job.outputThumbnailUrl && (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
              {downloading ? (
                <Loader2 className="w-4 h-4 text-white animate-spin" />
              ) : (
                <Download className="w-4 h-4 text-white" />
              )}
            </div>
          </button>
        )}
      </div>
      <CardContent className="p-3">
        <p className="text-xs text-white/60 truncate leading-relaxed">
          {job.promptText ?? "Sem descrição"}
        </p>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-white/30">{formatRelativeTime(job.createdAt)}</p>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-all ${
              confirmDelete
                ? "bg-red-500/20 text-red-400 border border-red-500/40"
                : "text-white/25 hover:text-red-400 hover:bg-red-500/10"
            }`}
          >
            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            {confirmDelete ? "Confirmar" : ""}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
