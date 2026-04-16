"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Radio, RefreshCw, Play, ExternalLink, Users,
  Heart, Clock, TrendingUp, Eye, Package, AlertTriangle,
  CheckCircle, Video, Loader2, Ban, Download, Trash2, Plus, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveProduct { name: string; thumbnailUrl?: string; priceFormatted?: string }

interface LiveSession {
  id: string; roomId: string; title: string; hostHandle: string; hostNickname: string;
  hostAvatarUrl: string; viewerCount: number; peakViewers: number;
  likeCount: number | string; totalViewers: number | string;
  estimatedOrders: number; productCount: number; products: LiveProduct[] | null;
  isLive: boolean; startedAt: string | null; durationSeconds: number | null;
  hlsUrl: string | null; liveUrl: string | null; thumbnailUrl: string | null;
  recordingStatus: string; recordingUrl: string | null;
  recordingDurationSeconds: number | null; recordingError: string | null;
  salesScore: number; scrapedAt: string;
}

interface ApiResponse {
  sessions: LiveSession[]; total: number; liveCount: number;
  replayCount: number; page: number; totalPages: number;
}

interface ScrapeResponse {
  total: number; liveNow: number; usedMock: boolean; hasApiKey: boolean;
  source: "mock" | "tikwm"; newSessions: number; newCreators: number; updatedSessions: number;
  debug?: { keywordsSearched: string[]; rawVideoCount: number; usedMock: boolean };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(n: number | string): string {
  const num = typeof n === "string" ? parseInt(n) : n;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function fmtDuration(s: number | null): string {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ""}`;
  if (m > 0) return `${m}m${sec > 0 ? ` ${sec}s` : ""}`;
  return `${sec}s`;
}

function fmtTimeAgo(d: string | null): string {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `há ${mins}min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `há ${hrs}h`;
  return `há ${Math.floor(hrs / 24)}d`;
}

const REC_COLORS: Record<string, string> = {
  NONE: "text-white/30", QUEUED: "text-yellow-400", RECORDING: "text-red-400",
  DONE: "text-emerald-400", FAILED: "text-red-500",
};
const REC_LABELS: Record<string, string> = {
  NONE: "", QUEUED: "Na fila", RECORDING: "Gravando…", DONE: "Gravado", FAILED: "Falhou",
};

// ── Recording badge ──────────────────────────────────────────────────────────

function RecBadge({ status }: { status: string }) {
  if (status === "NONE") return null;
  return (
    <span className={cn("flex items-center gap-1 text-[10px] font-semibold", REC_COLORS[status] ?? "text-white/40")}>
      {status === "RECORDING" && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
      {status === "QUEUED"    && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === "DONE"      && <CheckCircle className="w-3 h-3" />}
      {status === "FAILED"    && <Ban className="w-3 h-3" />}
      {REC_LABELS[status]}
    </span>
  );
}

// ── Live Card ────────────────────────────────────────────────────────────────

function LiveCard({ session, onRecord, onCancel, onDelete, onDeleteRecording, onStop, progress, recording, startedAt, finalizing }: {
  session: LiveSession;
  onRecord: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string, handle: string) => void;
  onDeleteRecording: (id: string) => void;
  onStop: (id: string) => void;
  progress?: { chunks: number; seconds: number };
  recording: boolean;
  startedAt?: number;
  finalizing?: boolean;
}) {
  const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const products   = session.products ?? [];
  const canRecord  = session.isLive && session.recordingStatus !== "RECORDING" && session.recordingStatus !== "QUEUED";
  const isRecording = session.recordingStatus === "RECORDING" || session.recordingStatus === "QUEUED";

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden hover:border-violet-500/20 transition-all group flex flex-col">
      {/* Thumbnail */}
      <div className="relative aspect-[9/16] max-h-60 bg-white/[0.03] overflow-hidden">
        {session.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={session.thumbnailUrl} alt={session.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-violet-900/20 to-red-900/20">
            <Radio className="w-10 h-10 text-white/20" />
          </div>
        )}
        {/* Live badge */}
        <div className="absolute top-2 left-2">
          {session.isLive ? (
            <span className="flex items-center gap-1 bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />AO VIVO
            </span>
          ) : (
            <span className="flex items-center gap-1 bg-black/60 text-white/70 text-[10px] px-2 py-0.5 rounded-full">
              <Play className="w-2.5 h-2.5" />Encerrada
            </span>
          )}
        </div>
        {/* Score */}
        <div className="absolute top-2 right-2 bg-black/70 px-2 py-0.5 rounded-full flex items-center gap-1">
          <TrendingUp className="w-3 h-3 text-violet-400" />
          <span className="text-[11px] font-bold text-white">{session.salesScore}</span>
        </div>
        {/* Delete (apaga live + creator) */}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(session.id, session.hostHandle); }}
          title="Apagar live e remover creator do pool"
          className="absolute top-10 right-2 bg-black/70 hover:bg-red-500/80 p-1 rounded-full text-white/70 hover:text-white transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
        {/* Rec status overlay */}
        {session.recordingStatus !== "NONE" && (
          <div className="absolute bottom-2 left-2">
            <RecBadge status={session.recordingStatus} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3 flex flex-col gap-2.5 flex-1">
        {/* Host */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center text-xs font-bold text-violet-300 flex-shrink-0">
            {(session.hostNickname || session.hostHandle)[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">{session.hostNickname || session.hostHandle}</p>
            <p className="text-[10px] text-white/40">@{session.hostHandle}</p>
          </div>
        </div>

        <p className="text-xs text-white/70 line-clamp-2 leading-snug">{session.title}</p>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-1">
          <div className="flex items-center gap-1 text-[11px] text-white/50">
            <Users className="w-3 h-3 text-cyan-400/70" />
            <span>{fmtNum(session.viewerCount)}</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-white/50">
            <Heart className="w-3 h-3 text-pink-400/70" />
            <span>{fmtNum(session.likeCount)}</span>
          </div>
          {session.productCount > 0 && (
            <div className="flex items-center gap-1 text-[11px] text-white/50">
              <Package className="w-3 h-3 text-violet-400/70" />
              <span>{session.productCount} produtos</span>
            </div>
          )}
          {session.startedAt && (
            <div className="flex items-center gap-1 text-[11px] text-white/30">
              <Clock className="w-3 h-3" />
              <span>{fmtTimeAgo(session.startedAt)}</span>
            </div>
          )}
        </div>

        {/* Products */}
        {products.length > 0 && (
          <div className="flex gap-1 overflow-x-auto scrollbar-none">
            {products.slice(0, 5).map((p, i) => (
              <div key={i} title={p.name}
                className="flex-shrink-0 w-8 h-8 rounded bg-white/[0.05] border border-white/[0.06] overflow-hidden">
                {p.thumbnailUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={p.thumbnailUrl} alt={p.name} className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center"><Package className="w-3 h-3 text-white/20" /></div>
                }
              </div>
            ))}
          </div>
        )}

        {/* HLS URL indicator */}
        {session.isLive && (
          <div className={cn("text-[10px] flex items-center gap-1", session.hlsUrl ? "text-emerald-400/70" : "text-white/25")}>
            <Video className="w-3 h-3" />
            {session.hlsUrl ? "Stream URL capturada ✓" : "Stream URL não disponível"}
          </div>
        )}

        {/* Recording live timer */}
        {recording && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[11px] font-semibold text-red-300">Gravando</span>
            <span className="text-[11px] font-mono text-red-200 ml-auto tabular-nums">
              {fmtDuration(elapsedSec)}
            </span>
          </div>
        )}

        {/* Recording error */}
        {session.recordingStatus === "FAILED" && session.recordingError && (
          <p className="text-[10px] text-red-400/70 line-clamp-2">{session.recordingError}</p>
        )}

        {/* Actions */}
        <div className="mt-auto flex gap-1.5">
          {session.liveUrl && (
            <a href={session.liveUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
              <Button size="sm" variant="outline"
                className={cn("w-full text-[10px] gap-1 border-white/10",
                  session.isLive ? "text-red-400 hover:text-red-300 border-red-500/20" : "text-white/50 hover:text-white")}>
                {session.isLive ? <><Radio className="w-3 h-3" />Assistir</> : <><Play className="w-3 h-3" />Ver</>}
                <ExternalLink className="w-2.5 h-2.5 opacity-50" />
              </Button>
            </a>
          )}
          {canRecord && !recording && (
            <Button size="sm"
              onClick={() => onRecord(session.id)}
              className="flex-1 text-[10px] gap-1 bg-red-500 hover:bg-red-600 text-white">
              <Video className="w-3 h-3" />Gravar
            </Button>
          )}
          {recording && !finalizing && (
            <Button size="sm" variant="outline"
              onClick={() => onStop(session.id)}
              className="flex-1 text-[10px] gap-1 border-red-500/30 text-red-400 hover:text-red-300">
              <Ban className="w-3 h-3" />
              Parar{progress && progress.chunks > 0 ? ` (${progress.chunks} chunk${progress.chunks > 1 ? "s" : ""})` : ""}
            </Button>
          )}
          {recording && finalizing && (
            <Button size="sm" variant="outline" disabled
              className="flex-1 text-[10px] gap-1 border-yellow-500/30 text-yellow-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Finalizando chunk…
            </Button>
          )}
          {isRecording && !recording && (
            <Button size="sm" variant="outline"
              onClick={() => onCancel(session.id)}
              className="flex-1 text-[10px] gap-1 border-white/10 text-white/50 hover:text-white">
              <Ban className="w-3 h-3" />Limpar
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Recording Card (aba "Gravações": só vídeo + nome do perfil) ──────────────

function RecordingCard({ session, onDeleteRecording }: {
  session: LiveSession;
  onDeleteRecording: (id: string) => void;
}) {
  if (!session.recordingUrl) return null;
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden hover:border-violet-500/20 transition-all flex flex-col">
      <video
        src={session.recordingUrl}
        controls
        className="w-full bg-black aspect-video"
        preload="metadata"
      />
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-full bg-violet-500/20 flex items-center justify-center text-xs font-bold text-violet-300 flex-shrink-0">
            {(session.hostNickname || session.hostHandle)[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-white truncate">{session.hostNickname || session.hostHandle}</p>
            <p className="text-[10px] text-white/40 truncate">@{session.hostHandle}</p>
          </div>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <a href={session.recordingUrl} target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline"
              className="text-[10px] border-white/10 text-white/60 hover:text-white gap-1 px-2">
              <Download className="w-3 h-3" />
            </Button>
          </a>
          <Button size="sm" variant="outline"
            onClick={() => onDeleteRecording(session.id)}
            title="Apagar gravação"
            className="text-[10px] border-red-500/20 text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1 px-2">
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type Filter = "all" | "live" | "recorded";

export default function LivesPage() {
  const [filter, setFilter]         = useState<Filter>("all");
  const [page, setPage]             = useState(1);
  const [data, setData]             = useState<ApiResponse | null>(null);
  const [loading, setLoading]       = useState(true);
  const [scraping, setScraping]     = useState(false);
  const [lastScrape, setLastScrape] = useState<ScrapeResponse | null>(null);
  const [actioning, setActioning]   = useState<Set<string>>(new Set());
  const [manualInput, setManualInput] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  // Controle do loop de gravação por sessionId
  const stopFlags = useRef<Map<string, boolean>>(new Map());
  // Set de IDs aguardando chunk atual finalizar após clique em Parar
  const [finalizingStop, setFinalizingStop] = useState<Set<string>>(new Set());
  const [recordingProgress, setRecordingProgress] = useState<Record<string, { chunks: number; seconds: number }>>({});
  // Timestamp (ms) em que cada gravação começou — usado pro ticker ao vivo.
  const [recordStartedAt, setRecordStartedAt] = useState<Record<string, number>>({});
  // Ticker: força re-render a cada 1s enquanto houver alguma gravação ativa.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Object.keys(recordStartedAt).length === 0) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [recordStartedAt]);

  const loadSessions = useCallback(async (f: Filter = filter, p: number = page) => {
    setLoading(true);
    try {
      const apiFilter = f === "recorded" ? "recorded" : f === "live" ? "live" : "all";
      const res  = await fetch(`/api/ugc/lives?filter=${apiFilter}&page=${p}`);
      const json = await res.json() as ApiResponse;
      setData(json);
    } finally { setLoading(false); }
  }, [filter, page]);

  useEffect(() => { loadSessions(filter, page); }, [filter, page, loadSessions]);

  // Reset pra página 1 ao trocar filtro
  useEffect(() => { setPage(1); }, [filter]);

  // Auto-refresh a cada 20s (status de gravação muda)
  useEffect(() => {
    const iv = setInterval(() => loadSessions(filter, page), 20_000);
    return () => clearInterval(iv);
  }, [filter, page, loadSessions]);

  async function handleScrape() {
    setScraping(true);
    try {
      const res  = await fetch("/api/ugc/lives/scrape", { method: "POST" });
      const json = await res.json() as ScrapeResponse;
      setLastScrape(json);
      await loadSessions(filter, page);
    } finally { setScraping(false); }
  }

  async function handleRecord(id: string) {
    // Inicia loop contínuo de chunks até live encerrar ou usuário clicar Parar.
    // Cada iteração grava um chunk de 240s via /record-now, depois checa stillLive.
    // Quando encerra: chama /record-now { finalize: true } pra concatenar chunks.
    stopFlags.current.set(id, false);
    setActioning((s) => new Set(s).add(id));
    setRecordStartedAt((m) => ({ ...m, [id]: Date.now() }));
    setData((d) =>
      d
        ? {
            ...d,
            sessions: d.sessions.map((s) =>
              s.id === id ? { ...s, recordingStatus: "RECORDING" } : s,
            ),
          }
        : d,
    );
    setRecordingProgress((p) => ({ ...p, [id]: { chunks: 0, seconds: 0 } }));

    let consecutiveErrors = 0;
    let userStopped = false;
    try {
      while (!stopFlags.current.get(id)) {
        // Chunks de 45s: stop fica "quase instantâneo" (máx ~45s de espera)
        // e garante que o ffmpeg sempre termina e salva o chunk no blob.
        const res = await fetch(`/api/ugc/lives/${id}/record-now`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ durationSeconds: 45 }),
        }).catch(() => null);

        if (stopFlags.current.get(id)) {
          userStopped = true;
          break;
        }

        if (!res || !res.ok) {
          // Parse body (JSON ou texto) pra extrair stillLive/msg
          let msg = "Sem detalhe";
          let stillLive = true;
          if (res) {
            const text = await res.text().catch(() => "");
            try {
              const j = JSON.parse(text) as { message?: string; error?: string; stillLive?: boolean };
              msg = j.message ?? j.error ?? text.slice(0, 120);
              if (typeof j.stillLive === "boolean") stillLive = j.stillLive;
            } catch {
              msg = text.slice(0, 120) || res.statusText;
            }
          }
          consecutiveErrors++;
          console.warn(`[record] chunk err (${consecutiveErrors}):`, msg);

          // Se backend confirma que live encerrou, para na hora pra finalizar.
          if (!stillLive) break;

          // Aborta só depois de 5 falhas seguidas. Entre tentativas, 3s.
          // Cron continua no BG então não é crítico dar up rápido.
          if (consecutiveErrors >= 5) break;
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        consecutiveErrors = 0;

        const json = (await res.json()) as {
          chunkSeconds?: number;
          cumulativeSeconds?: number;
          stillLive?: boolean;
        };
        setRecordingProgress((p) => ({
          ...p,
          [id]: {
            chunks: (p[id]?.chunks ?? 0) + 1,
            seconds: json.cumulativeSeconds ?? p[id]?.seconds ?? 0,
          },
        }));
        if (!json.stillLive) break;
        if (stopFlags.current.get(id)) { userStopped = true; break; }
      }

      // Finaliza: concatena chunks num único mp4 e marca DONE.
      // Quando userStopped=true (abort/parar), finalize imediatamente os chunks
      // já no blob — o chunk em andamento foi descartado mas os anteriores valem.
      const finRes = await fetch(`/api/ugc/lives/${id}/record-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finalize: true }),
      }).catch(() => null);
      if (!finRes || !finRes.ok) {
        console.warn("[record] finalize failed, cron pegará no próximo ciclo");
      }
      await loadSessions(filter, page);
    } finally {
      stopFlags.current.delete(id);
      setFinalizingStop((s) => { const n = new Set(s); n.delete(id); return n; });
      setRecordStartedAt((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
      setRecordingProgress((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
      setActioning((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  function handleStopRecording(id: string) {
    // Sinaliza stop graceful: loop sai depois do chunk atual completar
    // (máx ~45s). Abortar o fetch mataria o ffmpeg no meio e perderíamos
    // o chunk em andamento, então deixamos ele terminar e salvar no blob.
    stopFlags.current.set(id, true);
    setFinalizingStop((s) => new Set(s).add(id));
  }

  async function handleDelete(id: string, handle: string) {
    if (!confirm(`Apagar esta live e remover @${handle} do pool? Não virá mais nas próximas buscas.`)) return;
    setActioning((s) => new Set(s).add(id));
    try {
      await fetch(`/api/ugc/lives/${id}`, { method: "DELETE" });
      await fetch(`/api/ugc/lives/creators?handle=${encodeURIComponent(handle)}`, { method: "DELETE" });
      await loadSessions(filter, page);
    } finally {
      setActioning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function handleDeleteRecording(id: string) {
    if (!confirm("Apagar gravação? O arquivo será removido do Blob.")) return;
    setActioning((s) => new Set(s).add(id));
    try {
      await fetch(`/api/ugc/lives/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_recording" }),
      });
      await loadSessions(filter, page);
    } finally {
      setActioning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function handleAddManual() {
    if (!manualInput.trim()) return;
    setAddingManual(true);
    try {
      const res = await fetch("/api/ugc/lives/creators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: manualInput }),
      });
      const json = await res.json() as {
        success?: boolean;
        creator?: { handle: string };
        liveNow?: boolean;
        message?: string;
      };
      if (!res.ok) {
        alert(json.message ?? "Erro ao adicionar");
        return;
      }
      setManualInput("");
      if (json.liveNow) {
        await loadSessions(filter, page);
        alert(`@${json.creator?.handle} está AO VIVO agora — apareceu na lista.`);
      } else {
        alert(`@${json.creator?.handle} adicionado ao pool. Clique em "Buscar Lives" para checar quando estiver ao vivo.`);
      }
    } finally {
      setAddingManual(false);
    }
  }

  async function handleCancel(id: string) {
    setActioning((s) => new Set(s).add(id));
    try {
      await fetch(`/api/ugc/lives/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_recording" }),
      });
      await loadSessions(filter, page);
    } finally {
      setActioning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: "all",      label: "Todos",     count: data?.total },
    { key: "live",     label: "Ao Vivo",   count: data?.liveCount },
    { key: "recorded", label: "Gravações", count: data?.sessions.filter(s => s.recordingStatus === "DONE").length },
  ];

  const sessions = data?.sessions ?? [];
  const recordedCount = sessions.filter((s) => s.recordingStatus === "DONE").length;
  const recordingCount = sessions.filter((s) => ["QUEUED","RECORDING"].includes(s.recordingStatus)).length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Radio className="w-6 h-6 text-red-400" />Lives TikTok Shop
          </h1>
          <p className="text-sm text-white/50 mt-1">Detecta lives ao vivo, captura stream e grava automaticamente</p>
        </div>
        <Button onClick={handleScrape} disabled={scraping}
          className="gap-2 bg-red-500 hover:bg-red-600 text-white">
          <RefreshCw className={cn("w-4 h-4", scraping && "animate-spin")} />
          {scraping ? "Buscando lives…" : "Buscar Lives ao Vivo"}
        </Button>
      </div>

      {/* Manual live input */}
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
        <p className="text-xs font-semibold text-white/70 mb-2 flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5 text-violet-400" />
          Adicionar live manualmente
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddManual(); }}
            placeholder="Cole a URL da live (tiktok.com/@handle/live) ou só o @handle"
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-violet-500/40"
          />
          <Button
            onClick={handleAddManual}
            disabled={addingManual || !manualInput.trim()}
            className="gap-1.5 bg-violet-500 hover:bg-violet-600 text-white"
          >
            {addingManual ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Adicionar
          </Button>
        </div>
        <p className="text-[10px] text-white/30 mt-1.5">
          Adiciona o creator ao pool. Nas próximas buscas, se ele estiver ao vivo com carrinho laranja, aparece aqui.
        </p>
      </div>

      {/* Mock fallback warning */}
      {lastScrape?.usedMock && (
        <div className="flex items-start gap-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4">
          <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-300">Nenhum dado real encontrado — exibindo exemplo</p>
            <p className="text-xs text-yellow-400/60 mt-1">
              A fonte pública tikwm.com não retornou resultados agora. Tente novamente em alguns minutos.
            </p>
          </div>
        </div>
      )}

      {/* Real data banner */}
      {lastScrape && !lastScrape.usedMock && (
        <div className="flex items-center gap-2 text-xs text-emerald-400/80">
          <CheckCircle className="w-4 h-4" />
          {lastScrape.total} creator{lastScrape.total !== 1 ? "s" : ""} de TikTok Shop detectado{lastScrape.total !== 1 ? "s" : ""} —{" "}
          <strong className="text-emerald-300">{lastScrape.liveNow}</strong> ao vivo agora
          {lastScrape.newCreators > 0 ? (
            <span className="text-emerald-300 font-semibold">· +{lastScrape.newCreators} creator{lastScrape.newCreators !== 1 ? "s" : ""} novo{lastScrape.newCreators !== 1 ? "s" : ""}</span>
          ) : (
            <span className="text-white/40">· sem creators novos nessa rodada</span>
          )}
        </div>
      )}

      {/* Recording in progress */}
      {recordingCount > 0 && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
          <Video className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5 animate-pulse" />
          <div>
            <p className="text-sm font-medium text-red-300">
              {recordingCount} gravação{recordingCount !== 1 ? "ões" : ""} em andamento
            </p>
            <p className="text-xs text-red-400/60 mt-1">
              Gravação contínua em chunks de ~3min no servidor via ffmpeg. Roda até a live encerrar — mesmo com a aba fechada (cron garante continuidade).
            </p>
          </div>
        </div>
      )}

      {/* Stats */}
      {data && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { icon: Radio, color: "text-red-400 bg-red-500/10", val: data.liveCount, label: "Ao vivo agora" },
            { icon: Eye, color: "text-cyan-400 bg-cyan-500/10", val: data.total, label: "Total detectadas" },
            { icon: Video, color: "text-violet-400 bg-violet-500/10", val: recordingCount, label: "Gravando agora" },
            { icon: CheckCircle, color: "text-emerald-400 bg-emerald-500/10", val: recordedCount, label: "Gravações salvas" },
          ].map((s, i) => (
            <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4 flex items-center gap-3">
              <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", s.color)}>
                <s.icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xl font-bold text-white">{s.val}</p>
                <p className="text-xs text-white/40">{s.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2">
        {tabs.map((tab) => (
          <button key={tab.key} onClick={() => setFilter(tab.key)}
            className={cn("flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              filter === tab.key
                ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                : "text-white/50 hover:text-white hover:bg-white/[0.05]")}>
            {tab.label}
            {tab.count !== undefined && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full",
                filter === tab.key ? "bg-violet-500/30 text-violet-200" : "bg-white/[0.08] text-white/40")}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-[9/16] max-h-60 bg-white/[0.05]" />
              <div className="p-3 space-y-2">
                <div className="h-2.5 bg-white/[0.05] rounded w-3/4" />
                <div className="h-2 bg-white/[0.05] rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Radio className="w-12 h-12 text-white/10 mb-4" />
          <p className="text-white/40 font-medium">Nenhuma live encontrada</p>
          <p className="text-white/25 text-sm mt-1 mb-6">
            Clique em &ldquo;Buscar Lives ao Vivo&rdquo; para encontrar lives do TikTok Shop
          </p>
          <Button onClick={handleScrape} disabled={scraping} className="bg-red-500 hover:bg-red-600 text-white gap-2">
            <RefreshCw className={cn("w-4 h-4", scraping && "animate-spin")} />Buscar agora
          </Button>
        </div>
      ) : (
        filter === "recorded" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sessions
              .filter((s) => s.recordingStatus === "DONE" && s.recordingUrl)
              .map((s) => (
                <RecordingCard key={s.id} session={s} onDeleteRecording={handleDeleteRecording} />
              ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {sessions.map((s) => (
              <LiveCard key={s.id} session={s}
                onRecord={handleRecord} onCancel={handleCancel}
                onDelete={handleDelete} onDeleteRecording={handleDeleteRecording}
                onStop={handleStopRecording}
                progress={recordingProgress[s.id]}
                recording={actioning.has(s.id)}
                startedAt={recordStartedAt[s.id]}
                finalizing={finalizingStop.has(s.id)} />
            ))}
          </div>
        )
      )}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ‹
          </button>
          {Array.from({ length: data.totalPages }).map((_, i) => {
            const n = i + 1;
            const current = n === page;
            // Janela: sempre mostra 1, última, atual ±2. Resto vira "…"
            const show =
              n === 1 ||
              n === data.totalPages ||
              Math.abs(n - page) <= 2;
            const showEllipsisBefore = n === page - 3 && page - 3 > 1;
            const showEllipsisAfter = n === page + 3 && page + 3 < data.totalPages;
            if (showEllipsisBefore || showEllipsisAfter) {
              return <span key={n} className="px-2 text-white/30">…</span>;
            }
            if (!show) return null;
            return (
              <button
                key={n}
                onClick={() => setPage(n)}
                className={cn(
                  "min-w-[34px] px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  current
                    ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                    : "text-white/60 hover:text-white hover:bg-white/[0.05]",
                )}
              >
                {n}
              </button>
            );
          })}
          <button
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={page === data.totalPages}
            className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ›
          </button>
        </div>
      )}

    </div>
  );
}
