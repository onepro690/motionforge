"use client";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Zap,
  Shield,
  Layers,
  Play,
  CheckCircle,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#030712] text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-[#030712]/80 backdrop-blur-xl border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              MotionForge
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login">
              <Button
                variant="ghost"
                className="text-white/70 hover:text-white"
              >
                Entrar
              </Button>
            </Link>
            <Link href="/register">
              <Button className="bg-violet-600 hover:bg-violet-700 text-white">
                Começar grátis <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-24 px-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-violet-900/20 via-transparent to-transparent pointer-events-none" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-violet-600/5 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-5xl mx-auto text-center relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300 text-sm mb-8">
              <Star className="w-3 h-3 fill-violet-300" />
              <span>Powered by State-of-the-Art AI</span>
            </div>

            <h1 className="text-6xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
              Transferência de{" "}
              <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
                Movimento com IA
              </span>
            </h1>

            <p className="text-xl text-white/60 max-w-2xl mx-auto mb-10 leading-relaxed">
              Faça upload de qualquer vídeo de referência e uma foto de pessoa.
              Nossa IA transfere o movimento com precisão, preservando a
              identidade.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/register">
                <Button
                  size="lg"
                  className="bg-violet-600 hover:bg-violet-700 text-white h-14 px-8 text-lg rounded-xl"
                >
                  Criar conta grátis{" "}
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-14 px-8 text-lg rounded-xl border-white/10 text-white hover:bg-white/5"
                >
                  <Play className="mr-2 w-5 h-5" /> Ver demo
                </Button>
              </Link>
            </div>
          </motion.div>

          {/* Hero mockup */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="mt-20 relative"
          >
            <div className="rounded-2xl overflow-hidden border border-white/10 bg-[#0d1117] p-1 glow-violet">
              <div className="rounded-xl overflow-hidden bg-[#161b22] h-96 flex items-center justify-center">
                <div className="grid grid-cols-3 gap-6 p-8 w-full">
                  <div className="space-y-3">
                    <div className="text-xs text-white/40 uppercase tracking-wider">
                      Vídeo de Movimento
                    </div>
                    <div className="aspect-video rounded-lg bg-gradient-to-br from-violet-900/50 to-violet-800/30 border border-violet-500/20 flex items-center justify-center">
                      <Play className="w-8 h-8 text-violet-400" />
                    </div>
                  </div>
                  <div className="flex items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center shadow-lg">
                        <Zap className="w-6 h-6 text-white" />
                      </div>
                      <span className="text-xs text-white/40">
                        MotionForge AI
                      </span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div className="text-xs text-white/40 uppercase tracking-wider">
                      Resultado
                    </div>
                    <div className="aspect-video rounded-lg bg-gradient-to-br from-cyan-900/50 to-cyan-800/30 border border-cyan-500/20 flex items-center justify-center">
                      <Play className="w-8 h-8 text-cyan-400" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Como funciona</h2>
            <p className="text-white/50 text-lg">
              Três passos simples para criar vídeos incríveis
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "Upload do Vídeo",
                desc: "Envie um vídeo com o movimento que deseja transferir. Suporta mp4, mov e webm.",
                color: "violet",
              },
              {
                step: "02",
                title: "Upload da Foto",
                desc: "Envie uma foto da pessoa que vai executar o movimento. Nossa IA preserva a identidade.",
                color: "purple",
              },
              {
                step: "03",
                title: "Geração com IA",
                desc: "Nossa IA processa tudo de forma assíncrona e entrega um vídeo realista em minutos.",
                color: "cyan",
              },
            ].map((item) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="relative p-6 rounded-2xl bg-white/[0.03] border border-white/[0.08] hover:border-white/[0.15] transition-colors"
              >
                <div className="text-5xl font-black text-white/10 mb-4">
                  {item.step}
                </div>
                <h3 className="text-xl font-semibold mb-3">{item.title}</h3>
                <p className="text-white/50 leading-relaxed">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Recursos poderosos</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                icon: Shield,
                title: "Preservação de Identidade",
                desc: "A IA mantém o rosto e características da pessoa da foto intactos.",
              },
              {
                icon: Layers,
                title: "Consistência Temporal",
                desc: "Vídeos estáveis frame a frame, sem flickering ou inconsistências visuais.",
              },
              {
                icon: Zap,
                title: "Processamento Assíncrono",
                desc: "Envie seu job e acompanhe o progresso em tempo real. Sem travamentos.",
              },
              {
                icon: CheckCircle,
                title: "Múltiplos Providers de IA",
                desc: "Arquitetura modular suporta Replicate, ComfyUI e providers customizados.",
              },
            ].map((feature) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                className="flex gap-4 p-6 rounded-2xl bg-white/[0.03] border border-white/[0.08]"
              >
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
                  <feature.icon className="w-5 h-5 text-violet-400" />
                </div>
                <div>
                  <h3 className="font-semibold mb-2">{feature.title}</h3>
                  <p className="text-white/50 text-sm leading-relaxed">
                    {feature.desc}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 border-t border-white/5">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-5xl font-bold mb-6">Pronto para criar?</h2>
          <p className="text-white/50 text-xl mb-10">
            Comece a gerar vídeos com transferência de movimento agora mesmo.
          </p>
          <Link href="/register">
            <Button
              size="lg"
              className="bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-700 hover:to-cyan-700 text-white h-14 px-10 text-lg rounded-xl"
            >
              Criar conta grátis <ArrowRight className="ml-2 w-5 h-5" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="font-semibold text-sm">MotionForge</span>
          </div>
          <p className="text-white/30 text-sm">
            © 2025 MotionForge. Todos os direitos reservados.
          </p>
        </div>
      </footer>
    </div>
  );
}
