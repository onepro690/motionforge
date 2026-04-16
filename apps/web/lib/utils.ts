import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `${minutes}m atrás`;
  if (hours < 24) return `${hours}h atrás`;
  return `${days}d atrás`;
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: "Na Fila",
    PROCESSING: "Processando",
    RENDERING: "Renderizando",
    COMPLETED: "Concluído",
    FAILED: "Falhou",
  };
  return labels[status] ?? status;
}

// Download forçado via fetch+blob — funciona cross-origin (Vercel Blob, GCS, etc).
// <a download> NÃO funciona cross-origin — abre numa nova aba em vez de baixar.
export async function forceDownload(url: string, filename: string): Promise<void> {
  const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    // Fallback: tenta fetch direto (funciona se same-origin ou CORS ok)
    const directRes = await fetch(url);
    if (!directRes.ok) throw new Error("Falha ao baixar arquivo");
    const blob = await directRes.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
    return;
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(blobUrl);
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    QUEUED: "text-yellow-400 bg-yellow-400/10",
    PROCESSING: "text-blue-400 bg-blue-400/10",
    RENDERING: "text-purple-400 bg-purple-400/10",
    COMPLETED: "text-green-400 bg-green-400/10",
    FAILED: "text-red-400 bg-red-400/10",
  };
  return colors[status] ?? "text-gray-400 bg-gray-400/10";
}
