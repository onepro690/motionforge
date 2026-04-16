"use client";
import { useState, useRef, useCallback } from "react";
import {
  Upload,
  X,
  ArrowUp,
  ArrowDown,
  Merge,
  Download,
  Loader2,
  Film,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { mergeVideosClient } from "@/lib/merge-videos";

interface VideoItem {
  id: string;
  file: File;
  name: string;
  url: string;
}

export default function JoinPage() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [merging, setMerging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputType, setOutputType] = useState("video/mp4");
  const inputRef = useRef<HTMLInputElement>(null);

  const addVideos = useCallback((files: FileList | null) => {
    if (!files) return;
    const newItems: VideoItem[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("video/")) continue;
      const url = URL.createObjectURL(file);
      newItems.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        name: file.name,
        url,
      });
    }
    setVideos((prev) => [...prev, ...newItems]);
  }, []);

  const removeVideo = (id: string) => {
    setVideos((prev) => {
      const item = prev.find((v) => v.id === id);
      if (item) URL.revokeObjectURL(item.url);
      return prev.filter((v) => v.id !== id);
    });
  };

  const moveVideo = (id: string, dir: -1 | 1) => {
    setVideos((prev) => {
      const idx = prev.findIndex((v) => v.id === id);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    addVideos(e.dataTransfer.files);
  };

  const handleMerge = async () => {
    if (videos.length < 2) {
      toast.error("Adicione pelo menos 2 vídeos para juntar.");
      return;
    }
    setMerging(true);
    setProgress(0);
    setOutputUrl(null);
    try {
      const blob = await mergeVideosClient(
        videos.map((v) => v.file),
        (pct, label) => { setProgress(pct); setProgressLabel(label); }
      );
      const url = URL.createObjectURL(blob);
      setOutputType(blob.type);
      setOutputUrl(url);
      setProgress(100);
      toast.success("Vídeos juntados com sucesso!");
    } catch (error) {
      console.error("[join]", error);
      toast.error(error instanceof Error ? error.message : "Erro ao juntar vídeos", { duration: 8000 });
    } finally {
      setMerging(false);
    }
  };

  const reset = () => {
    videos.forEach((v) => URL.revokeObjectURL(v.url));
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    setVideos([]);
    setOutputUrl(null);
    setProgress(0);
    setProgressLabel("");
  };

  const ext = outputType.includes("mp4") ? "mp4" : "webm";

  if (outputUrl) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Vídeo Pronto</h1>
          <p className="text-white/50 mt-1">{videos.length} vídeos juntados em um único arquivo</p>
        </div>
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="pt-6">
            <video src={outputUrl} controls className="w-full rounded-lg bg-black" />
          </CardContent>
        </Card>
        <div className="flex gap-3">
          <a href={outputUrl} download={`videos_juntados.${ext}`} className="flex-1">
            <Button variant="outline" className="w-full border-white/10 text-white hover:bg-white/5">
              <Download className="w-4 h-4 mr-2" />Baixar Vídeo Final
            </Button>
          </a>
          <Button onClick={reset} className="flex-1 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white">
            <RefreshCw className="w-4 h-4 mr-2" />Juntar Outros Vídeos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Juntar Vídeos</h1>
        <p className="text-white/50 mt-1">Adicione vídeos na ordem desejada e junte tudo em um único arquivo</p>
      </div>

      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="border-2 border-dashed border-white/[0.12] rounded-xl p-8 text-center cursor-pointer hover:border-violet-500/40 hover:bg-violet-500/5 transition-all"
      >
        <Upload className="w-8 h-8 text-white/30 mx-auto mb-3" />
        <p className="text-white/60 text-sm font-medium">Arraste vídeos aqui ou clique para selecionar</p>
        <p className="text-white/30 text-xs mt-1">MP4, MOV, WebM — pode selecionar vários de uma vez</p>
        <input ref={inputRef} type="file" accept="video/*" multiple className="hidden" onChange={(e) => addVideos(e.target.files)} />
      </div>

      {videos.length > 0 && (
        <div className="space-y-2">
          <p className="text-white/40 text-xs uppercase tracking-wider px-1">
            {videos.length} vídeo{videos.length !== 1 ? "s" : ""} — na ordem de junção
          </p>
          {videos.map((v, i) => (
            <div key={v.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] border border-white/[0.08]">
              <div className="w-16 h-10 rounded bg-black/40 flex-shrink-0 overflow-hidden">
                <video src={v.url} className="w-full h-full object-cover" muted />
              </div>
              <div className="w-6 h-6 rounded-full bg-violet-500/20 flex items-center justify-center text-xs font-bold text-violet-300 flex-shrink-0">{i + 1}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/80 truncate">{v.name}</p>
                <p className="text-xs text-white/30">{(v.file.size / 1024 / 1024).toFixed(1)} MB</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => moveVideo(v.id, -1)} disabled={i === 0} className="p-1.5 rounded text-white/30 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"><ArrowUp className="w-3.5 h-3.5" /></button>
                <button onClick={() => moveVideo(v.id, 1)} disabled={i === videos.length - 1} className="p-1.5 rounded text-white/30 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"><ArrowDown className="w-3.5 h-3.5" /></button>
                <button onClick={() => removeVideo(v.id)} className="p-1.5 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
          <button onClick={() => inputRef.current?.click()} className="w-full p-2.5 rounded-lg border border-dashed border-white/[0.08] text-white/30 hover:text-white/60 hover:border-white/20 text-sm transition-colors flex items-center justify-center gap-2">
            <Film className="w-4 h-4" />Adicionar mais vídeos
          </button>
        </div>
      )}

      {merging && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-violet-400 animate-spin flex-shrink-0" />
              <span className="text-sm text-white/70">{progressLabel}</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-white/30">Processando no navegador — não feche esta aba. Tempo proporcional à duração total.</p>
          </CardContent>
        </Card>
      )}

      <Button onClick={handleMerge} disabled={videos.length < 2 || merging} className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-12 text-base font-medium disabled:opacity-40">
        {merging ? <><Loader2 className="w-5 h-5 animate-spin mr-2" />Juntando...</> : <><Merge className="w-5 h-5 mr-2" />Juntar {videos.length >= 2 ? `${videos.length} Vídeos` : "Vídeos"}</>}
      </Button>

      {videos.length < 2 && <p className="text-center text-xs text-white/30">Adicione pelo menos 2 vídeos para juntar</p>}
    </div>
  );
}
