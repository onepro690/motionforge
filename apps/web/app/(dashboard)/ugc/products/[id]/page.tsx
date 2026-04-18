"use client";
import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, TrendingUp, ThumbsUp, ThumbsDown, Bookmark,
  Eye, Heart, MessageCircle, Share2, ExternalLink, Edit2,
  Check, X, Loader2, Zap, Users, Video, Search, Globe,
  Copy, CheckCheck, Plus, Trash2, Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { proxyImage, handleImageError } from "@/lib/ugc/image-url";

type ProductStatus = "DETECTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "SAVED_FOR_LATER" | "USED_FOR_GENERATION";

interface DetectedVideo {
  id: string;
  videoId: string;
  creatorHandle: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  description: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  collectedAt: string;
}

interface Product {
  id: string;
  name: string;
  category: string | null;
  niche: string | null;
  thumbnailUrl: string | null;
  productUrl: string | null;
  score: number;
  status: ProductStatus;
  detectedVideoCount: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalComments: number;
  viewGrowthRate: number;
  engagementRate: number;
  creatorCount: number;
  accelerationScore: number;
  trendSummary: string | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  detectedVideos: DetectedVideo[];
  _count: { generatedVideos: number };
}

const STATUS_COLORS: Record<ProductStatus, string> = {
  DETECTED: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  UNDER_REVIEW: "bg-yellow-500/10 text-yellow-300 border-yellow-500/20",
  APPROVED: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  REJECTED: "bg-red-500/10 text-red-300 border-red-500/20",
  SAVED_FOR_LATER: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  USED_FOR_GENERATION: "bg-violet-500/10 text-violet-300 border-violet-500/20",
};

const STATUS_LABELS: Record<ProductStatus, string> = {
  DETECTED: "Detectado",
  UNDER_REVIEW: "Em Revisão",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  SAVED_FOR_LATER: "Salvo",
  USED_FOR_GENERATION: "Em Uso",
};

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function EditableField({
  label, value, onSave, multiline = false, placeholder,
}: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<void>;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="group flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-white/40 mb-1">{label}</p>
          <p className={`text-sm text-white ${!value && "text-white/30 italic"}`}>
            {value || placeholder || "Não definido"}
          </p>
        </div>
        <button
          onClick={() => { setDraft(value); setEditing(true); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity mt-4 p-1 rounded hover:bg-white/10"
        >
          <Edit2 className="w-3.5 h-3.5 text-white/40" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-white/40 mb-1">{label}</p>
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-violet-500/50"
        />
      ) : (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500/50"
        />
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1 px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-xs"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Salvar
        </button>
        <button
          onClick={() => setEditing(false)}
          className="flex items-center gap-1 px-3 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 text-white/60 text-xs"
        >
          <X className="w-3 h-3" />
          Cancelar
        </button>
      </div>
    </div>
  );
}

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [generatingDesc, setGeneratingDesc] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAddVideo, setShowAddVideo] = useState(false);
  const [newVideoUrl, setNewVideoUrl] = useState("");
  const [addingVideo, setAddingVideo] = useState(false);
  const [deletingVideo, setDeletingVideo] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ugc/products/${id}`);
      if (res.ok) setProduct(await res.json());
      else router.push("/ugc/products");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const patch = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/ugc/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const updated = await res.json();
      setProduct((prev) => prev ? { ...prev, ...updated } : prev);
      toast.success("Salvo");
    } else {
      toast.error("Erro ao salvar");
      throw new Error("patch failed");
    }
  };

  const updateStatus = async (status: ProductStatus) => {
    setActionLoading(true);
    try {
      await patch({ status });
      if (status === "APPROVED") toast.success("Produto aprovado!");
      else if (status === "REJECTED") toast.success("Produto rejeitado");
    } finally {
      setActionLoading(false);
    }
  };

  const generateDescription = async () => {
    if (!product) return;
    setGeneratingDesc(true);
    try {
      // Build description from detected video descriptions
      const descriptions = product.detectedVideos
        .slice(0, 8)
        .map((v) => v.description)
        .filter(Boolean)
        .join("\n");

      const res = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptions: [
            `Produto: ${product.name}\n\nDescrições de vídeos detectados no TikTok:\n${descriptions}\n\nEscreva uma descrição curta (2-3 frases) sobre o que é esse produto, seus benefícios principais e por que está em alta no TikTok Shop. Responda em português.`,
          ],
          mode: "summary",
        }),
      });

      if (res.ok) {
        const json = await res.json();
        const summary = json.prompts?.[0] ?? json.prompt ?? json.result ?? "";
        if (summary) {
          await patch({ trendSummary: summary.slice(0, 800) });
          toast.success("Descrição gerada!");
        }
      } else {
        toast.error("Erro ao gerar descrição");
      }
    } finally {
      setGeneratingDesc(false);
    }
  };

  const copyName = () => {
    if (!product) return;
    navigator.clipboard.writeText(product.name);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const addVideo = async () => {
    if (!newVideoUrl.trim()) return;
    setAddingVideo(true);
    try {
      const res = await fetch(`/api/ugc/products/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: newVideoUrl.trim() }),
      });
      if (res.ok) {
        toast.success("Vídeo adicionado!");
        setNewVideoUrl("");
        setShowAddVideo(false);
        load();
      } else {
        const data = await res.json();
        toast.error(data.error ?? "Erro ao adicionar vídeo");
      }
    } finally {
      setAddingVideo(false);
    }
  };

  const deleteVideo = async (videoDbId: string) => {
    setDeletingVideo(videoDbId);
    try {
      const res = await fetch(`/api/ugc/products/${id}/videos/${videoDbId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Vídeo removido");
        load();
      } else {
        toast.error("Erro ao remover vídeo");
      }
    } finally {
      setDeletingVideo(null);
    }
  };

  const tiktokSearchUrl = product
    ? `https://www.tiktok.com/search?q=${encodeURIComponent(product.name)}`
    : "";

  const tiktokShopSearchUrl = product
    ? `https://shop.tiktok.com/search?q=${encodeURIComponent(product.name)}`
    : "";

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
      </div>
    );
  }

  if (!product) return null;

  const shopLink = product.productUrl || tiktokShopSearchUrl;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Back */}
      <div className="flex items-center gap-3">
        <Link href="/ugc/products">
          <Button variant="ghost" size="sm" className="text-white/50 hover:text-white -ml-2">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Produtos
          </Button>
        </Link>
      </div>

      {/* Hero */}
      <div className="flex flex-col md:flex-row gap-6">
        {/* Thumbnail */}
        <div className="shrink-0">
          {product.thumbnailUrl ? (
            <img
              src={proxyImage(product.thumbnailUrl)}
              alt={product.name}
              onError={handleImageError(product.thumbnailUrl)}
              className="w-full md:w-48 h-48 rounded-2xl object-cover border border-white/10"
            />
          ) : (
            <div className="w-full md:w-48 h-48 rounded-2xl bg-violet-500/10 flex items-center justify-center border border-white/10">
              <TrendingUp className="w-12 h-12 text-violet-400/50" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 space-y-4">
          {/* Name + status */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_COLORS[product.status]}`}>
                  {STATUS_LABELS[product.status]}
                </span>
                {product.category && (
                  <span className="text-xs text-white/30">{product.category}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-white leading-tight">{product.name}</h1>
                <button onClick={copyName} className="p-1 rounded hover:bg-white/10 transition-colors">
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-white/30" />}
                </button>
              </div>
              <p className="text-xs text-white/30 mt-1">
                Detectado em {new Date(product.firstDetectedAt).toLocaleDateString("pt-BR")} •
                Atualizado em {new Date(product.lastDetectedAt).toLocaleDateString("pt-BR")}
              </p>
            </div>

            {/* Score */}
            <div className="text-center">
              <div className={`text-4xl font-black ${product.score >= 70 ? "text-emerald-400" : product.score >= 40 ? "text-yellow-400" : "text-white/40"}`}>
                {product.score}
              </div>
              <p className="text-xs text-white/30">score</p>
            </div>
          </div>

          {/* TikTok Shop links */}
          <div className="flex flex-wrap gap-2">
            <a
              href={shopLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#ff0050]/10 border border-[#ff0050]/20 text-[#ff6b8a] hover:bg-[#ff0050]/20 transition-colors text-sm font-medium"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" xmlns="http://www.w3.org/2000/svg">
                <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.76a4.85 4.85 0 01-1.01-.07z"/>
              </svg>
              {product.productUrl ? "Ver no TikTok Shop" : "Buscar no TikTok Shop"}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <a
              href={tiktokSearchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.05] border border-white/10 text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors text-sm"
            >
              <Search className="w-4 h-4" />
              Buscar no TikTok
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {product.status !== "APPROVED" && product.status !== "REJECTED" && (
              <>
                <Button
                  size="sm"
                  className="bg-emerald-600/80 hover:bg-emerald-600 text-white"
                  onClick={() => updateStatus("APPROVED")}
                  disabled={actionLoading}
                >
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ThumbsUp className="w-4 h-4 mr-1" />}
                  Aprovar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-white/10 text-white/50 hover:text-white"
                  onClick={() => updateStatus("SAVED_FOR_LATER")}
                  disabled={actionLoading}
                >
                  <Bookmark className="w-4 h-4 mr-1" />
                  Salvar para depois
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/20 text-red-400/70 hover:text-red-400"
                  onClick={() => updateStatus("REJECTED")}
                  disabled={actionLoading}
                >
                  <ThumbsDown className="w-4 h-4 mr-1" />
                  Rejeitar
                </Button>
              </>
            )}
            {product.status === "APPROVED" && (
              <>
                <Link href={`/ugc?generate=${product.id}`}>
                  <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white">
                    <Zap className="w-4 h-4 mr-1" />
                    Gerar Vídeo UGC
                  </Button>
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-red-500/20 text-red-400/60 hover:text-red-400"
                  onClick={() => updateStatus("REJECTED")}
                  disabled={actionLoading}
                >
                  <ThumbsDown className="w-4 h-4 mr-1" />
                  Rejeitar
                </Button>
              </>
            )}
            {product.status === "REJECTED" && (
              <Button
                size="sm"
                className="bg-emerald-600/80 hover:bg-emerald-600 text-white"
                onClick={() => updateStatus("APPROVED")}
                disabled={actionLoading}
              >
                <ThumbsUp className="w-4 h-4 mr-1" />
                Aprovar mesmo assim
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Views", value: formatViews(Number(product.totalViews)), icon: Eye, color: "text-blue-400" },
          { label: "Total Likes", value: formatViews(Number(product.totalLikes)), icon: Heart, color: "text-pink-400" },
          { label: "Creators", value: product.creatorCount, icon: Users, color: "text-violet-400" },
          { label: "Vídeos", value: product.detectedVideoCount, icon: Video, color: "text-cyan-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="bg-white/[0.03] border-white/[0.06] p-4">
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${color}`} />
              <p className="text-xs text-white/40">{label}</p>
            </div>
            <p className="text-xl font-bold text-white">{value}</p>
          </Card>
        ))}
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-white/[0.03] border-white/[0.06] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white/70">Informações do Produto</h3>

          <EditableField
            label="Nome do produto"
            value={product.name}
            onSave={(v) => patch({ name: v })}
            placeholder="Nome como aparece no TikTok Shop"
          />

          <EditableField
            label="Link direto no TikTok Shop"
            value={product.productUrl ?? ""}
            onSave={(v) => patch({ productUrl: v || "" })}
            placeholder="https://shop.tiktok.com/..."
          />

          <EditableField
            label="Categoria"
            value={product.category ?? ""}
            onSave={(v) => patch({ category: v })}
            placeholder="Ex: Beleza, Casa, Tecnologia"
          />
        </Card>

        <Card className="bg-white/[0.03] border-white/[0.06] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white/70">Descrição / Por que está em alta</h3>
            <button
              onClick={generateDescription}
              disabled={generatingDesc}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 text-xs transition-colors"
            >
              {generatingDesc ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              Gerar com IA
            </button>
          </div>

          <EditableField
            label=""
            value={product.trendSummary ?? ""}
            onSave={(v) => patch({ trendSummary: v })}
            multiline
            placeholder="Clique em 'Gerar com IA' para criar uma descrição automática baseada nos vídeos detectados, ou escreva manualmente."
          />
        </Card>
      </div>

      {/* Videos */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white/70">
            Vídeos de Referência ({product.detectedVideos.length})
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/30">Clique para abrir no TikTok</span>
            <Button
              size="sm"
              variant="outline"
              className="border-white/10 text-white/60 hover:text-white text-xs h-7"
              onClick={() => setShowAddVideo(!showAddVideo)}
            >
              <Plus className="w-3 h-3 mr-1" />
              Adicionar Vídeo
            </Button>
          </div>
        </div>

        {/* Add video form */}
        {showAddVideo && (
          <Card className="bg-white/[0.03] border-white/[0.06] p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="w-4 h-4 text-violet-400" />
              <p className="text-sm font-medium text-white">Adicionar vídeo manualmente</p>
            </div>
            <p className="text-xs text-white/40 mb-3">
              Cole o link do TikTok do vídeo de referência que quer usar para gerar UGC.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newVideoUrl}
                onChange={(e) => setNewVideoUrl(e.target.value)}
                placeholder="https://www.tiktok.com/@usuario/video/1234567890"
                className="flex-1 bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50"
                onKeyDown={(e) => e.key === "Enter" && addVideo()}
              />
              <Button
                size="sm"
                className="bg-violet-600 hover:bg-violet-500 text-white h-9"
                onClick={addVideo}
                disabled={addingVideo || !newVideoUrl.trim()}
              >
                {addingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
                Adicionar
              </Button>
            </div>
          </Card>
        )}

        {product.detectedVideos.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {product.detectedVideos.map((video) => {
              const link = video.videoUrl && video.videoUrl.startsWith("https://www.tiktok.com")
                ? video.videoUrl
                : `https://www.tiktok.com/@${video.creatorHandle}/video/${video.videoId}`;

              return (
                <div key={video.id} className="relative group">
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={video.description ?? ""}
                    className="block relative rounded-xl overflow-hidden border border-white/10 hover:border-violet-500/40 transition-all hover:scale-[1.02]"
                  >
                    {video.thumbnailUrl ? (
                      <img
                        src={proxyImage(video.thumbnailUrl)}
                        alt=""
                        onError={handleImageError(video.thumbnailUrl)}
                        className="w-full aspect-[9/16] object-cover"
                      />
                    ) : (
                      <div className="w-full aspect-[9/16] bg-white/[0.03] flex items-center justify-center">
                        <Video className="w-6 h-6 text-white/20" />
                      </div>
                    )}

                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white ml-0.5" xmlns="http://www.w3.org/2000/svg">
                          <path d="M8 5v14l11-7z"/>
                        </svg>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-white absolute top-2 right-2" />
                    </div>

                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                      <p className="text-xs text-white/80 font-medium truncate">@{video.creatorHandle}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <div className="flex items-center gap-0.5">
                          <Eye className="w-2.5 h-2.5 text-white/50" />
                          <span className="text-xs text-white/50">{formatViews(Number(video.views))}</span>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <Heart className="w-2.5 h-2.5 text-pink-400/70" />
                          <span className="text-xs text-white/50">{formatViews(Number(video.likes))}</span>
                        </div>
                      </div>
                    </div>
                  </a>
                  {/* Delete button */}
                  <button
                    onClick={() => deleteVideo(video.id)}
                    disabled={deletingVideo === video.id}
                    className="absolute top-1.5 left-1.5 z-10 p-1.5 rounded-lg bg-black/60 border border-white/10 text-white/40 hover:text-red-400 hover:border-red-500/30 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    {deletingVideo === video.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <Card className="bg-white/[0.02] border-white/[0.06] p-8 text-center">
            <Video className="w-8 h-8 text-white/20 mx-auto mb-2" />
            <p className="text-sm text-white/40">Nenhum vídeo de referência</p>
            <p className="text-xs text-white/20 mt-1">Adicione um vídeo do TikTok para usar como referência</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 border-white/10 text-white/60"
              onClick={() => setShowAddVideo(true)}
            >
              <Plus className="w-3 h-3 mr-1" />
              Adicionar Vídeo
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
