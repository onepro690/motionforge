"use client";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  TrendingUp, ThumbsUp, ThumbsDown, Bookmark, Eye, Loader2,
  RefreshCw, Users, Video, ArrowUpRight, ChevronLeft, ChevronRight, Filter, Sparkles,
  UserCircle, X, Plus, Link2, Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface Character {
  id: string;
  name: string;
  imageUrl: string;
}

type ProductStatus = "DETECTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "SAVED_FOR_LATER" | "USED_FOR_GENERATION";

interface Product {
  id: string;
  name: string;
  category: string | null;
  thumbnailUrl: string | null;
  score: number;
  status: ProductStatus;
  detectedVideoCount: number;
  totalViews: number;
  creatorCount: number;
  viewGrowthRate: number;
  engagementRate: number;
  firstDetectedAt: string;
  trendSummary: string | null;
  detectedVideos: Array<{ thumbnailUrl: string | null; creatorHandle: string | null; views: number }>;
  _count: { detectedVideos: number; generatedVideos: number };
  totalLikes: number;
}

const STATUS_LABELS: Record<ProductStatus, string> = {
  DETECTED: "Detectado",
  UNDER_REVIEW: "Em Revisão",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  SAVED_FOR_LATER: "Salvo",
  USED_FOR_GENERATION: "Em Uso",
};

const STATUS_COLORS: Record<ProductStatus, string> = {
  DETECTED: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  UNDER_REVIEW: "bg-yellow-500/10 text-yellow-300 border-yellow-500/20",
  APPROVED: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  REJECTED: "bg-red-500/10 text-red-300 border-red-500/20",
  SAVED_FOR_LATER: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  USED_FOR_GENERATION: "bg-violet-500/10 text-violet-300 border-violet-500/20",
};

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? "text-emerald-400" : score >= 40 ? "text-yellow-400" : "text-white/40";
  return <span className={`text-lg font-bold ${color}`}>{score}</span>;
}

export default function ProductsPage() {
  const searchParams = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [regenLoading, setRegenLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "");

  // Add video manually
  const [showAddVideo, setShowAddVideo] = useState(false);
  const [newVideoUrl, setNewVideoUrl] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [addingVideo, setAddingVideo] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState<string | null>(null);

  // Character picker modal
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charPickerProductId, setCharPickerProductId] = useState<string | null>(null);
  const [charPickerAction, setCharPickerAction] = useState<"approve" | "regen">("approve");

  const loadCharacters = useCallback(async () => {
    const res = await fetch("/api/ugc/characters");
    if (res.ok) {
      const data = await res.json();
      setCharacters(data.characters);
    }
  }, []);

  useEffect(() => { loadCharacters(); }, [loadCharacters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "12" });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/ugc/products?${params}`);
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Abre o picker de personagem antes de gerar
  const startGeneration = (productId: string, action: "approve" | "regen") => {
    setCharPickerProductId(productId);
    setCharPickerAction(action);
  };

  // Gera vídeo (com personagem OU modo sem avatar / phenotype swap)
  const generateWithCharacter = async (
    opts: { characterId: string } | { noAvatar: true }
  ) => {
    const productId = charPickerProductId;
    if (!productId) return;
    setCharPickerProductId(null);

    const payload: Record<string, unknown> = { productIds: [productId], count: 1 };
    if ("characterId" in opts) payload.characterId = opts.characterId;
    if ("noAvatar" in opts) payload.noAvatar = true;

    if (charPickerAction === "approve") {
      setActionLoading(productId);
      try {
        const res = await fetch(`/api/ugc/products/${productId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "APPROVED" }),
        });
        if (!res.ok) { toast.error("Erro ao atualizar status"); return; }

        toast.success("Produto aprovado! Iniciando geração do vídeo…");
        const genRes = await fetch("/api/ugc/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const genText = await genRes.text();
        let genJson: { videosCreated?: number; error?: string } = {};
        try { genJson = JSON.parse(genText); } catch { genJson = { error: `Resposta inválida (${genRes.status}): ${genText.slice(0, 200)}` }; }
        if (genRes.ok && (genJson.videosCreated ?? 0) > 0) {
          toast.success("Vídeo em geração — aparecerá em Review quando pronto", { duration: 6000 });
        } else {
          toast.error(genJson.error ?? `Erro ${genRes.status}: ${genText.slice(0, 200)}`);
        }
        load();
      } finally {
        setActionLoading(null);
      }
    } else {
      setRegenLoading(productId);
      try {
        const res = await fetch("/api/ugc/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        let json: { videosCreated?: number; error?: string } = {};
        try { json = JSON.parse(text); } catch { json = { error: `Resposta inválida (${res.status}): ${text.slice(0, 200)}` }; }
        if (res.ok && (json.videosCreated ?? 0) > 0) {
          toast.success("Novo vídeo em geração — aparecerá em Review quando pronto", { duration: 6000 });
        } else {
          toast.error(json.error ?? `Erro ${res.status}: ${text.slice(0, 200)}`);
        }
      } catch (err) {
        toast.error(`Erro de rede: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRegenLoading(null);
      }
    }
  };

  const updateStatus = async (id: string, status: ProductStatus) => {
    if (status === "APPROVED") {
      startGeneration(id, "approve");
      return;
    }
    setActionLoading(id);
    try {
      const res = await fetch(`/api/ugc/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) { toast.error("Erro ao atualizar status"); return; }
      toast.success(status === "REJECTED" ? "Produto rejeitado" : "Status atualizado");
      load();
    } finally {
      setActionLoading(null);
    }
  };

  const regenerate = (id: string) => {
    startGeneration(id, "regen");
  };

  const deleteProduct = async (productId: string) => {
    if (!confirm("Tem certeza que quer apagar este produto?")) return;
    setDeletingProduct(productId);
    try {
      const res = await fetch(`/api/ugc/products/${productId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Produto apagado");
        load();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao apagar produto");
      }
    } finally {
      setDeletingProduct(null);
    }
  };

  const handleAddVideo = async () => {
    if (!newVideoUrl.trim() || !newProductName.trim()) return;
    setAddingVideo(true);
    try {
      const res = await fetch("/api/ugc/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: newVideoUrl.trim(), productName: newProductName.trim() }),
      });
      if (res.ok) {
        toast.success("Produto criado com vídeo de referência!");
        setNewVideoUrl("");
        setNewProductName("");
        setShowAddVideo(false);
        load();
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Erro ao adicionar");
      }
    } finally {
      setAddingVideo(false);
    }
  };

  const handleScrape = async () => {
    setScraping(true);
    try {
      const res = await fetch("/api/ugc/scrape", { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        toast.success(`${json.newProducts} novos produtos detectados`);
        load();
      } else {
        toast.error(json.error ?? "Erro");
      }
    } finally {
      setScraping(false);
    }
  };

  const filters = [
    { label: "Todos", value: "" },
    { label: "Detectados", value: "DETECTED" },
    { label: "Aprovados", value: "APPROVED" },
    { label: "Salvos", value: "SAVED_FOR_LATER" },
    { label: "Rejeitados", value: "REJECTED" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-violet-400" />
            Produtos em Alta
          </h1>
          <p className="text-sm text-white/40 mt-1">
            {total} produto{total !== 1 ? "s" : ""} detectado{total !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddVideo(!showAddVideo)}
            className="border-violet-500/20 text-violet-300 hover:text-violet-200 hover:bg-violet-500/10"
          >
            <Plus className="w-4 h-4 mr-2" />
            Adicionar Vídeo
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleScrape}
            disabled={scraping}
            className="border-white/10 text-white/70 hover:text-white"
          >
            {scraping ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Atualizar Tendências
          </Button>
        </div>
      </div>

      {/* Add video form */}
      {showAddVideo && (
        <Card className="bg-white/[0.03] border-violet-500/20 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Link2 className="w-4 h-4 text-violet-400" />
            <p className="text-sm font-semibold text-white">Adicionar vídeo manualmente</p>
          </div>
          <p className="text-xs text-white/40 mb-4">
            Cole o link de um vídeo do TikTok e dê um nome ao produto. O vídeo será usado como referência para gerar UGC.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newProductName}
              onChange={(e) => setNewProductName(e.target.value)}
              placeholder="Nome do produto"
              className="sm:w-56 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50"
            />
            <input
              type="text"
              value={newVideoUrl}
              onChange={(e) => setNewVideoUrl(e.target.value)}
              placeholder="https://www.tiktok.com/@usuario/video/1234567890"
              className="flex-1 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50"
              onKeyDown={(e) => e.key === "Enter" && handleAddVideo()}
            />
            <Button
              size="sm"
              className="bg-violet-600 hover:bg-violet-500 text-white h-9 px-4"
              onClick={handleAddVideo}
              disabled={addingVideo || !newVideoUrl.trim() || !newProductName.trim()}
            >
              {addingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Adicionar
            </Button>
          </div>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => { setStatusFilter(f.value); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === f.value
                ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                : "text-white/40 hover:text-white hover:bg-white/[0.05] border border-transparent"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
        </div>
      ) : products.length === 0 ? (
        <Card className="bg-white/[0.02] border-white/[0.06] p-12 text-center">
          <TrendingUp className="w-10 h-10 text-white/20 mx-auto mb-3" />
          <p className="text-white/40 text-sm">Nenhum produto encontrado</p>
          <p className="text-white/20 text-xs mt-1">Clique em "Atualizar Tendências" para detectar novos produtos</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {products.map((product) => (
            <Card key={product.id} className="bg-white/[0.03] border-white/[0.06] p-4 flex flex-col gap-3 hover:bg-white/[0.05] transition-colors">
              {/* Header — clicking navigates to detail */}
              <Link href={`/ugc/products/${product.id}`} className="block">
              <div className="flex items-start justify-between gap-2">
                <div className="flex gap-3">
                  {product.thumbnailUrl ? (
                    <img src={product.thumbnailUrl} alt={product.name} className="w-12 h-12 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                      <TrendingUp className="w-5 h-5 text-violet-400" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white leading-tight line-clamp-2">{product.name}</p>
                    {product.category && (
                      <p className="text-xs text-white/40 mt-0.5">{product.category}</p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <ScoreBadge score={product.score} />
                  <p className="text-xs text-white/30">score</p>
                </div>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between">
                <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_COLORS[product.status]}`}>
                  {STATUS_LABELS[product.status]}
                </span>
                <span className="text-xs text-white/30">
                  {new Date(product.firstDetectedAt).toLocaleDateString("pt-BR")}
                </span>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="text-center">
                  <p className="text-white/40">Views</p>
                  <p className="text-white font-medium">{formatViews(Number(product.totalViews))}</p>
                </div>
                <div className="text-center">
                  <p className="text-white/40">Creators</p>
                  <p className="text-white font-medium">{product.creatorCount}</p>
                </div>
                <div className="text-center">
                  <p className="text-white/40">Vídeos</p>
                  <p className="text-white font-medium">{product._count.detectedVideos}</p>
                </div>
              </div>

              </Link>

              {/* Actions */}
              <div className="flex gap-2 pt-1">
                {product.status !== "APPROVED" && product.status !== "REJECTED" && product.status !== "USED_FOR_GENERATION" && (
                  <>
                    <Button
                      size="sm"
                      className="flex-1 bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs h-8"
                      onClick={() => updateStatus(product.id, "APPROVED")}
                      disabled={actionLoading === product.id}
                    >
                      {actionLoading === product.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3 mr-1" />}
                      Aprovar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 border-white/10 text-white/50 hover:text-white text-xs h-8"
                      onClick={() => updateStatus(product.id, "SAVED_FOR_LATER")}
                      disabled={actionLoading === product.id}
                    >
                      <Bookmark className="w-3 h-3 mr-1" />
                      Salvar
                    </Button>
                  </>
                )}
                {(product.status === "APPROVED" || product.status === "USED_FOR_GENERATION") && (
                  <Button
                    size="sm"
                    className="flex-1 bg-violet-600/80 hover:bg-violet-600 text-white text-xs h-8"
                    onClick={() => regenerate(product.id)}
                    disabled={regenLoading === product.id}
                  >
                    {regenLoading === product.id ? (
                      <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    ) : (
                      <Sparkles className="w-3 h-3 mr-1" />
                    )}
                    Gerar Novamente
                  </Button>
                )}
                {product.status === "REJECTED" && (
                  <Button
                    size="sm"
                    className="flex-1 bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs h-8"
                    onClick={() => updateStatus(product.id, "APPROVED")}
                    disabled={actionLoading === product.id}
                  >
                    <ThumbsUp className="w-3 h-3 mr-1" />
                    Aprovar
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/20 text-red-400/50 hover:text-red-400 hover:bg-red-500/10 text-xs h-8 px-2"
                  onClick={() => deleteProduct(product.id)}
                  disabled={deletingProduct === product.id}
                >
                  {deletingProduct === product.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > 12 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-white/40">Mostrando {Math.min((page - 1) * 12 + 1, total)}–{Math.min(page * 12, total)} de {total}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-white/10 text-white/60" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" className="border-white/10 text-white/60" onClick={() => setPage((p) => p + 1)} disabled={page * 12 >= total}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Character picker modal */}
      {charPickerProductId && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setCharPickerProductId(null)}>
          <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-6 max-w-md w-full space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <UserCircle className="w-5 h-5 text-violet-400" />
                Como gerar o vídeo?
              </h3>
              <button onClick={() => setCharPickerProductId(null)} className="text-white/40 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Opção "Sem avatar" — destaque no topo */}
            <button
              onClick={() => generateWithCharacter({ noAvatar: true })}
              className="w-full rounded-xl border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 transition-colors p-4 text-left flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-5 h-5 text-violet-300" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">Sem avatar — só trocar fenótipo</p>
                <p className="text-xs text-white/50 mt-0.5">Copia o vídeo 100% e só muda o rosto/etnia/cabelo das pessoas via prompt.</p>
              </div>
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-white/[0.06]" />
              <span className="text-[10px] uppercase tracking-wider text-white/30">ou com personagem fixo</span>
              <div className="flex-1 h-px bg-white/[0.06]" />
            </div>

            {characters.length === 0 ? (
              <div className="text-center py-4">
                <UserCircle className="w-8 h-8 text-white/20 mx-auto mb-2" />
                <p className="text-sm text-white/40">Nenhum personagem criado</p>
                <Link href="/ugc/personagens">
                  <Button size="sm" className="mt-3 bg-violet-600 hover:bg-violet-500 text-white">
                    Criar Personagem
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 max-h-72 overflow-y-auto">
                {characters.map((char) => (
                  <button
                    key={char.id}
                    onClick={() => generateWithCharacter({ characterId: char.id })}
                    className="group rounded-xl overflow-hidden border-2 border-transparent hover:border-violet-500 transition-all"
                  >
                    <div className="aspect-[3/4] relative">
                      <img src={char.imageUrl} alt={char.name} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                      <p className="absolute bottom-1.5 left-2 right-2 text-xs font-semibold text-white truncate">{char.name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
