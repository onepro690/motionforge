"use client";

import { useState } from "react";
import {
  Youtube, ArrowRight, Download, CheckCircle2,
  Terminal, FolderOpen, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Phase = "idle" | "triggered";

function isYouTubeUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(hostname);
  } catch {
    return false;
  }
}

const STEPS = [
  {
    num: "1",
    title: "Baixe o instalador",
    desc: "Clique no botão abaixo para baixar o arquivo instalar.bat.",
  },
  {
    num: "2",
    title: "Execute o arquivo",
    desc: 'Dê dois cliques no arquivo baixado (instalar.bat). Se aparecer aviso do Windows, clique em "Mais informações" → "Executar assim mesmo".',
  },
  {
    num: "3",
    title: "Pronto — use normalmente",
    desc: "Cole o link do YouTube aqui, clique em Ir e o terminal abre automaticamente com o download.",
  },
];

export default function YoutubePage() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [setupOpen, setSetupOpen] = useState(false);

  const trigger = () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    if (!isYouTubeUrl(trimmed)) {
      toast.error("Cole um link válido do YouTube");
      return;
    }

    window.location.href = `motionforge://download?url=${encodeURIComponent(trimmed)}`;
    setPhase("triggered");
    setTimeout(() => setPhase("idle"), 6000);
  };

  return (
    <div className="max-w-xl mx-auto space-y-5">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Youtube className="w-6 h-6 text-red-500" />
          YouTube Downloader
        </h1>
        <p className="text-white/40 text-sm mt-1">
          MP4 com áudio · até 1080p · salvo direto no PC
        </p>
      </div>

      {/* Setup accordion */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <button
          onClick={() => setSetupOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-medium text-white/80 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-violet-400" />
            Primeira vez usando? Clique aqui para configurar
          </span>
          {setupOpen
            ? <ChevronUp className="w-4 h-4 text-white/40" />
            : <ChevronDown className="w-4 h-4 text-white/40" />}
        </button>

        {setupOpen && (
          <div className="px-4 pb-4 space-y-4 border-t border-white/[0.06] pt-4">

            {/* Steps */}
            <div className="space-y-3">
              {STEPS.map((step) => (
                <div key={step.num} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-violet-500/20 text-violet-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                    {step.num}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{step.title}</p>
                    <p className="text-xs text-white/40 mt-0.5 leading-relaxed">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Download button */}
            <a
              href="/setup/instalar.bat"
              download="instalar.bat"
              className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              Baixar Instalador (instalar.bat)
            </a>

            {/* Note */}
            <div className="p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] space-y-1.5 text-xs text-white/40">
              <p className="flex items-center gap-1.5">
                <FolderOpen className="w-3 h-3 text-white/30 flex-shrink-0" />
                Vídeos salvos automaticamente em{" "}
                <span className="font-mono text-white/60">Downloads\YouTube\</span>
              </p>
              <p>
                Precisa ter o{" "}
                <span className="text-white/60 font-medium">yt-dlp</span> instalado.
                Se não tiver, abra o PowerShell e execute:{" "}
                <code className="bg-white/10 px-1.5 py-0.5 rounded font-mono text-white/70">
                  pip install yt-dlp
                </code>
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* URL Input + botão */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardContent className="p-4 space-y-3">
          <label className="text-sm font-medium text-white/70">Link do vídeo</label>
          <input
            type="url"
            placeholder="https://youtube.com/watch?v=..."
            value={url}
            onChange={(e) => { setUrl(e.target.value); setPhase("idle"); }}
            onKeyDown={(e) => e.key === "Enter" && trigger()}
            className="w-full bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          />

          <Button
            onClick={trigger}
            disabled={!url.trim() || phase === "triggered"}
            className={cn(
              "w-full text-white font-medium transition-all",
              phase === "triggered"
                ? "bg-emerald-600 hover:bg-emerald-600"
                : "bg-violet-600 hover:bg-violet-500"
            )}
          >
            {phase === "triggered" ? (
              <><CheckCircle2 className="w-4 h-4 mr-2" />Terminal aberto — baixando...</>
            ) : (
              <><ArrowRight className="w-4 h-4 mr-2" />Ir</>
            )}
          </Button>

          {phase === "triggered" && (
            <p className="text-center text-white/40 text-xs">
              Um terminal abriu no seu PC com o progresso do download.
            </p>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
