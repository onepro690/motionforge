"use client";
import Link from "next/link";
import { Wand2, Radio, ArrowRight } from "lucide-react";

export default function HubPage() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-white mb-2">O que você quer fazer?</h1>
          <p className="text-white/40">Escolha um módulo para começar</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card: Criar vídeos/imagens */}
          <Link
            href="/dashboard"
            className="group block rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden hover:border-white/[0.15] transition-all duration-200 hover:bg-white/[0.05]"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <span className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="flex-1 text-center text-xs text-white/40 font-medium">
                Criar vídeos/imagens
              </span>
            </div>
            <div className="p-6 flex flex-col gap-4 min-h-[180px]">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center flex-shrink-0 shadow-lg">
                  <Wand2 className="w-6 h-6 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-white mb-1">Criar vídeos/imagens</h2>
                  <p className="text-sm text-white/50 leading-relaxed">
                    Gere vídeos animados com IA usando motion transfer, texto ou geração de imagens.
                  </p>
                </div>
              </div>
              <div className="flex justify-end mt-auto">
                <div className="w-9 h-9 rounded-full bg-violet-500 hover:bg-violet-400 flex items-center justify-center transition-colors shadow-lg">
                  <ArrowRight className="w-4 h-4 text-white" />
                </div>
              </div>
            </div>
          </Link>

          {/* Card: TikTok Live */}
          <Link
            href="/live"
            className="group block rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden hover:border-white/[0.15] transition-all duration-200 hover:bg-white/[0.05]"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <span className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="flex-1 text-center text-xs text-white/40 font-medium">
                TikTok Live
              </span>
            </div>
            <div className="p-6 flex flex-col gap-4 min-h-[180px]">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center flex-shrink-0 shadow-lg">
                  <Radio className="w-6 h-6 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-semibold text-white mb-1">TikTok Live</h2>
                  <p className="text-sm text-white/50 leading-relaxed">
                    Faça lives no TikTok Shop com avatar IA falando seu script de forma natural e automática.
                  </p>
                </div>
              </div>
              <div className="flex justify-end mt-auto">
                <div className="w-9 h-9 rounded-full bg-pink-500 hover:bg-pink-400 flex items-center justify-center transition-colors shadow-lg">
                  <ArrowRight className="w-4 h-4 text-white" />
                </div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
