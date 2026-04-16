"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  TrendingUp, Video, Star, AlertCircle, Zap, RefreshCw,
  CheckCircle, Clock, Play, Loader2, ChevronRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

interface DashboardData {
  products: { detected: number; approved: number; pending: number };
  videos: {
    total: number; pendingReview: number; approved: number;
    failed: number; today: number; dailyLimit: number; remainingToday: number;
  };
  recentErrors: Array<{ step: string; message: string; createdAt: string; videoId: string }>;
}

function StatCard({ label, value, sub, icon: Icon, href, color = "violet" }: {
  label: string; value: number | string; sub?: string;
  icon: React.ElementType; href?: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    violet: "text-violet-400 bg-violet-500/10",
    cyan: "text-cyan-400 bg-cyan-500/10",
    green: "text-emerald-400 bg-emerald-500/10",
    red: "text-red-400 bg-red-500/10",
    yellow: "text-yellow-400 bg-yellow-500/10",
  };
  const inner = (
    <Card className="bg-white/[0.03] border-white/[0.06] p-5 hover:bg-white/[0.05] transition-colors">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-white/40 uppercase tracking-wide mb-1">{label}</p>
          <p className="text-3xl font-bold text-white">{value}</p>
          {sub && <p className="text-xs text-white/40 mt-1">{sub}</p>}
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colorMap[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default function UgcDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [scraping, setScraping] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    const res = await fetch("/api/ugc/dashboard");
    if (res.ok) setData(await res.json());
  };

  useEffect(() => { load(); }, []);

  const handleScrape = async () => {
    setScraping(true);
    try {
      const res = await fetch("/api/ugc/scrape", { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        toast.success(`${json.newProducts} novos produtos detectados, ${json.updatedProducts} atualizados`);
        load();
      } else {
        toast.error(json.error ?? "Erro ao fazer scraping");
      }
    } finally {
      setScraping(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/ugc/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) });
      const json = await res.json();
      if (res.ok) {
        toast.success(`${json.videosCreated} vídeo(s) em geração!`);
        load();
      } else {
        toast.error(json.error ?? "Erro ao gerar vídeos");
      }
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-violet-400" />
            TikTok Shop Auto UGC
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Máquina automática de criação de vídeos UGC com IA
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleScrape}
            disabled={scraping}
            className="border-white/10 text-white/70 hover:text-white"
          >
            {scraping ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Detectar Tendências
          </Button>
          <Button
            size="sm"
            onClick={handleGenerate}
            disabled={generating || !data || data.videos.remainingToday === 0}
            className="bg-violet-600 hover:bg-violet-700 text-white"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Zap className="w-4 h-4 mr-2" />}
            Gerar Vídeo
          </Button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Produtos em Alta" value={data?.products.detected ?? "-"} icon={TrendingUp} href="/ugc/products" color="violet" />
        <StatCard label="Produtos Aprovados" value={data?.products.approved ?? "-"} sub="prontos para gerar" icon={CheckCircle} href="/ugc/products?status=APPROVED" color="green" />
        <StatCard label="Aguardando Review" value={data?.videos.pendingReview ?? "-"} icon={Clock} href="/ugc/review" color="yellow" />
        <StatCard label="Vídeos Hoje" value={data ? `${data.videos.today}/${data.videos.dailyLimit}` : "-"} sub={data ? `${data.videos.remainingToday} restantes` : undefined} icon={Video} color="cyan" />
      </div>

      {/* Pipeline flow */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-white/[0.03] border-white/[0.06] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center text-sm font-bold text-violet-300">1</div>
            <div>
              <p className="text-sm font-semibold text-white">Descoberta</p>
              <p className="text-xs text-white/40">Detectar produtos em alta</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Detectados</span>
              <span className="text-white font-medium">{data?.products.detected ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Aguardando aprovação</span>
              <span className="text-yellow-400 font-medium">{data?.products.pending ?? 0}</span>
            </div>
          </div>
          <Link href="/ugc/products">
            <Button variant="outline" size="sm" className="w-full mt-4 border-white/10 text-white/60 hover:text-white text-xs">
              Ver Produtos <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </Card>

        <Card className="bg-white/[0.03] border-white/[0.06] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center text-sm font-bold text-cyan-300">2</div>
            <div>
              <p className="text-sm font-semibold text-white">Geração</p>
              <p className="text-xs text-white/40">Criar vídeos com IA</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Gerados hoje</span>
              <span className="text-white font-medium">{data?.videos.today ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Limite diário</span>
              <span className="text-cyan-400 font-medium">{data?.videos.dailyLimit ?? 10}</span>
            </div>
          </div>
          <Link href="/ugc/generations">
            <Button variant="outline" size="sm" className="w-full mt-4 border-white/10 text-white/60 hover:text-white text-xs">
              Ver Gerações <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </Card>

        <Card className="bg-white/[0.03] border-white/[0.06] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center text-sm font-bold text-emerald-300">3</div>
            <div>
              <p className="text-sm font-semibold text-white">Aprovação</p>
              <p className="text-xs text-white/40">Revisar e aprovar vídeos</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Na fila de review</span>
              <span className="text-yellow-400 font-medium">{data?.videos.pendingReview ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/50">Aprovados</span>
              <span className="text-emerald-400 font-medium">{data?.videos.approved ?? 0}</span>
            </div>
          </div>
          <Link href="/ugc/review">
            <Button variant="outline" size="sm" className="w-full mt-4 border-white/10 text-white/60 hover:text-white text-xs">
              Ir para Review <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </Card>
      </div>

      {/* Recent errors */}
      {data?.recentErrors && data.recentErrors.length > 0 && (
        <Card className="bg-red-500/5 border-red-500/20 p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <h3 className="text-sm font-semibold text-red-300">Falhas Recentes</h3>
          </div>
          <div className="space-y-2">
            {data.recentErrors.map((err, i) => (
              <div key={i} className="flex items-start justify-between text-xs">
                <div>
                  <span className="text-red-400 font-medium">[{err.step}]</span>{" "}
                  <span className="text-white/60">{err.message?.slice(0, 80)}</span>
                </div>
                <Link href={`/ugc/generations?id=${err.videoId}`} className="text-red-400/60 hover:text-red-400 ml-2 shrink-0">
                  ver
                </Link>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { href: "/ugc/products", label: "Produtos em Alta", icon: TrendingUp },
          { href: "/ugc/generations", label: "Gerações", icon: Video },
          { href: "/ugc/templates", label: "Templates", icon: Star },
          { href: "/ugc/settings", label: "Configurações", icon: Zap },
        ].map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href}>
            <Card className="bg-white/[0.02] border-white/[0.06] p-4 hover:bg-white/[0.05] transition-colors cursor-pointer flex items-center gap-3">
              <Icon className="w-4 h-4 text-violet-400" />
              <span className="text-sm text-white/70">{label}</span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
