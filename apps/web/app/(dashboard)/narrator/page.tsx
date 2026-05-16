"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Mic, Loader2, Download, Sparkles, Upload, X, User, Volume2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { upload } from "@vercel/blob/client";
import { parseConversationTurns } from "@/lib/narrator/parse-conversation";

type Phase = "idle" | "submitting" | "polling" | "done" | "error";
type AudioMode = "veo_native" | "tts_overlay";
type MixMode = "avatar" | "broll" | "mixed" | "conversation";
type Gender = "male" | "female";

interface SegmentSummary {
  index: number;
  text: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  error?: string | null;
  usedFallback?: boolean;
}

interface PollResponse {
  id: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  finalVideoUrl?: string | null;
  errorMessage?: string | null;
  narrationDurationSeconds?: number;
  segments?: SegmentSummary[];
  progress?: { completed: number; total: number };
}

const COPY_EXAMPLES = [
  "Você acorda cedo. Toma seu café. Mas a vida continua igual. E se a sua próxima decisão mudasse tudo? Conheça o caminho que milhares já trilharam para sair do comum.",
];

export default function NarratorPage() {
  const [copy, setCopy] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [narrationDuration, setNarrationDuration] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Avatar (opcional)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [audioMode, setAudioMode] = useState<AudioMode>("veo_native");
  const [mixMode, setMixMode] = useState<MixMode>("avatar");
  // Modo conversation: gênero da pessoa à esquerda (A) e à direita (B)
  const [genderA, setGenderA] = useState<Gender>("male");
  const [genderB, setGenderB] = useState<Gender>("female");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Polling loop
  useEffect(() => {
    if (phase !== "polling" || !jobId) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/narrator/${jobId}`);
        const data = (await res.json()) as PollResponse;
        if (cancelled) return;

        if (data.segments) setSegments(data.segments);
        if (data.progress) setProgress(data.progress);
        if (data.narrationDurationSeconds) setNarrationDuration(data.narrationDurationSeconds);

        if (data.status === "COMPLETED" && data.finalVideoUrl) {
          setFinalUrl(data.finalVideoUrl);
          setPhase("done");
          toast.success("Vídeo pronto!");
          return;
        }
        if (data.status === "FAILED") {
          setError(data.errorMessage ?? "Falhou");
          setPhase("error");
          toast.error(data.errorMessage ?? "Falhou");
          return;
        }
        // continua polling
        pollRef.current = setTimeout(tick, 8000);
      } catch (err) {
        if (cancelled) return;
        // erro transiente — tenta de novo em 10s
        pollRef.current = setTimeout(tick, 10000);
      }
    };

    pollRef.current = setTimeout(tick, 4000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [phase, jobId]);

  const handleAvatarSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Selecione uma imagem (jpg, png, webp)");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error("Imagem grande demais (máx 20MB)");
      return;
    }
    setUploadingAvatar(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const blob = await upload(`narrator-avatar-${Date.now()}.${ext}`, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
      });
      setAvatarUrl(blob.url);
      toast.success("Avatar carregado");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao subir avatar";
      toast.error(msg);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAvatarRemove = () => {
    setAvatarUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Colar imagem (Ctrl+V) quando ainda não há avatar — funciona em qualquer foco
  // pq textarea ignora paste de imagem, então rotear pro avatar é seguro.
  useEffect(() => {
    if (avatarUrl || phase === "submitting" || phase === "polling" || uploadingAvatar) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void handleAvatarSelect(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [avatarUrl, phase, uploadingAvatar]);

  const handleSubmit = async () => {
    const trimmed = copy.trim();
    if (trimmed.length < 20) {
      toast.error("Escreva uma copy com pelo menos 20 caracteres");
      return;
    }
    if (trimmed.length > 4000) {
      toast.error("Copy muito longa (limite 4000 caracteres)");
      return;
    }
    // Validação extra modo conversation
    if (avatarUrl && mixMode === "conversation") {
      const turns = parseConversationTurns(trimmed);
      const aCount = turns.filter((t) => t.speaker === "A").length;
      const bCount = turns.filter((t) => t.speaker === "B").length;
      if (aCount === 0 || bCount === 0) {
        toast.error("Use [A] e [B] na copy pra marcar quem fala cada linha.");
        return;
      }
    }
    setPhase("submitting");
    setError(null);
    setFinalUrl(null);
    setSegments([]);
    setProgress(null);
    setNarrationDuration(null);
    try {
      const res = await fetch("/api/narrator/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          copy: trimmed,
          gender,
          avatarImageUrl: avatarUrl ?? undefined,
          audioMode: avatarUrl ? audioMode : undefined,
          mixMode: avatarUrl ? mixMode : "broll",
          ...(avatarUrl && mixMode === "conversation" ? { genderA, genderB } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao iniciar geração");
      setJobId(data.id);
      setNarrationDuration(data.narrationDurationSeconds ?? null);
      setPhase("polling");
      toast.info(`Narração de ${Math.round(data.narrationDurationSeconds ?? 0)}s. ${data.takeCount} takes em geração.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar";
      setError(msg);
      setPhase("error");
      toast.error(msg);
    }
  };

  const handleReset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setPhase("idle");
    setJobId(null);
    setFinalUrl(null);
    setError(null);
    setSegments([]);
    setProgress(null);
    setNarrationDuration(null);
  };

  // Download forçado: fetch → blob → click invisível. <a download> direto não
  // funciona pq o vídeo está em blob.vercel-storage.com (cross-origin) — o
  // navegador ignora o atributo download e abre o vídeo no player.
  const handleDownload = async () => {
    if (!finalUrl) return;
    setDownloading(true);
    try {
      const res = await fetch(finalUrl);
      if (!res.ok) throw new Error(`Download falhou: ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `narrator-${jobId ?? Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // libera memória depois de um tick
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao baixar";
      toast.error(msg);
    } finally {
      setDownloading(false);
    }
  };

  const isLocked = phase === "submitting" || phase === "polling";
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? segments.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Modo misturado força TTS overlay (mais consistente entre estilos)
  const effectiveAudioMode: AudioMode = mixMode === "mixed" ? "tts_overlay" : audioMode;
  const veoNativeMode = Boolean(avatarUrl) && effectiveAudioMode === "veo_native";
  const voiceLabel = veoNativeMode ? "Gênero da voz pedido ao Veo" : "Voz do narrador";
  const maleLabel = veoNativeMode ? "Masculina" : "Homem · Onyx";
  const femaleLabel = veoNativeMode ? "Feminina" : "Mulher · Nova";
  // Toggle de áudio só relevante em modo 'avatar' puro (mixed/conversation forçam)
  const showAudioModeToggle = Boolean(avatarUrl) && mixMode === "avatar";
  // Voz genérica única só relevante quando NÃO é conversation (que tem A/B)
  const showSingleVoice = mixMode !== "conversation";

  // Preview de turnos parseados em tempo real (modo conversation)
  const conversationPreview = useMemo(() => {
    if (mixMode !== "conversation") return null;
    const turns = parseConversationTurns(copy);
    const aCount = turns.filter((t) => t.speaker === "A").length;
    const bCount = turns.filter((t) => t.speaker === "B").length;
    const totalWords = turns.reduce((acc, t) => acc + t.text.split(/\s+/).filter(Boolean).length, 0);
    const estimatedSecs = Math.round(totalWords / 2.8);
    return { turns, aCount, bCount, estimatedSecs, takes: turns.length };
  }, [copy, mixMode]);

  const insertTagAtCursor = (tag: "[A]" | "[B]") => {
    const ta = textareaRef.current;
    if (!ta) {
      setCopy((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${tag} `);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = copy.slice(0, start);
    const after = copy.slice(end);
    const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
    const needsSpaceAfter = after.length === 0 || !/^\s/.test(after);
    const insertion = `${needsSpaceBefore ? " " : ""}${tag}${needsSpaceAfter ? " " : ""}`;
    const next = `${before}${insertion}${after}`;
    setCopy(next);
    // Reposiciona cursor depois do tag (após o RAF do setState)
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      const pos = before.length + insertion.length;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
    });
  };

  const conversationInvalid = mixMode === "conversation" && conversationPreview
    ? conversationPreview.aCount === 0 || conversationPreview.bCount === 0
    : false;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Mic className="w-6 h-6 text-violet-400" />
          Narrador IA
        </h1>
        <p className="text-white/40 text-sm mt-1">
          Cole sua copy. Opcionalmente envie a foto de um avatar pra ele falar a copy diretamente, ou deixe sem avatar pra gerar B-roll cinematográfico narrado.
        </p>
      </div>

      <Card className="bg-white/[0.03] border-white/[0.08]">
        <CardContent className="p-5 space-y-4">
          {/* Avatar (opcional) */}
          <div>
            <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5"><User className="w-3.5 h-3.5" /> Avatar (opcional)</span>
              {avatarUrl && (
                <button
                  onClick={handleAvatarRemove}
                  disabled={isLocked}
                  className="text-white/40 hover:text-white/80 text-[10px] normal-case tracking-normal flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> remover
                </button>
              )}
            </label>
            {avatarUrl ? (
              <div className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.08] rounded-lg p-2">
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="w-16 h-16 rounded-md object-cover border border-white/10"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-white/80 text-sm font-medium truncate">Avatar carregado</p>
                  <p className="text-white/40 text-xs">A foto vai ser o frame inicial de cada take — fundo e identidade ficam idênticos.</p>
                </div>
              </div>
            ) : (
              <label
                className={cn(
                  "flex items-center justify-center gap-2 px-4 py-4 rounded-lg border border-dashed border-white/[0.12] bg-white/[0.02] text-white/50 text-sm cursor-pointer hover:bg-white/[0.04] hover:text-white/70 transition",
                  isLocked && "opacity-50 cursor-not-allowed",
                  uploadingAvatar && "opacity-60 cursor-wait"
                )}
              >
                {uploadingAvatar ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                <span>{uploadingAvatar ? "Subindo foto..." : "Subir foto do avatar (ou Ctrl+V pra colar)"}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={isLocked || uploadingAvatar}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleAvatarSelect(f);
                  }}
                />
              </label>
            )}
          </div>

          {/* Modo de produção (só quando há avatar) */}
          {avatarUrl && (
            <div>
              <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 block">
                Modo de produção
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setMixMode("avatar")}
                  disabled={isLocked}
                  className={cn(
                    "px-2 py-3 rounded-lg border text-xs font-medium transition-all text-left",
                    mixMode === "avatar"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold text-sm">Só avatar</div>
                  <div className="text-[10px] text-white/40 mt-0.5">Avatar falando do começo ao fim.</div>
                </button>
                <button
                  onClick={() => setMixMode("mixed")}
                  disabled={isLocked}
                  className={cn(
                    "px-2 py-3 rounded-lg border text-xs font-medium transition-all text-left",
                    mixMode === "mixed"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold text-sm">Misturado</div>
                  <div className="text-[10px] text-white/40 mt-0.5">Avatar + B-roll + avatar recortado em cenário.</div>
                </button>
                <button
                  onClick={() => setMixMode("conversation")}
                  disabled={isLocked}
                  className={cn(
                    "px-2 py-3 rounded-lg border text-xs font-medium transition-all text-left",
                    mixMode === "conversation"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold text-sm flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Conversa (2 pessoas)</div>
                  <div className="text-[10px] text-white/40 mt-0.5">Foto com 2 avatares. Tags [A]/[B] na copy.</div>
                </button>
                <button
                  onClick={() => setMixMode("broll")}
                  disabled={isLocked}
                  className={cn(
                    "px-2 py-3 rounded-lg border text-xs font-medium transition-all text-left",
                    mixMode === "broll"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold text-sm">Só B-roll</div>
                  <div className="text-[10px] text-white/40 mt-0.5">Cinematográfico, sem avatar.</div>
                </button>
              </div>
              {mixMode === "mixed" && (
                <p className="text-[11px] text-white/30 mt-1.5">
                  Cada trecho da copy escolhe sozinho o estilo (avatar / B-roll / avatar em cenário). Áudio: TTS Onyx/Nova sobreposta.
                </p>
              )}
              {mixMode === "conversation" && (
                <p className="text-[11px] text-violet-300/70 mt-1.5">
                  📸 A pessoa à <strong>esquerda</strong> da foto é <strong>A</strong>, à <strong>direita</strong> é <strong>B</strong>. Veo gera lip-sync nativo por take.
                </p>
              )}
            </div>
          )}

          {/* Gêneros por pessoa — modo conversation */}
          {avatarUrl && mixMode === "conversation" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 block">
                  Voz pessoa A (esquerda)
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => setGenderA("male")}
                    disabled={isLocked}
                    className={cn(
                      "px-2 py-2 rounded-md border text-xs font-medium transition-all",
                      genderA === "male"
                        ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                        : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                      isLocked && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    Masc.
                  </button>
                  <button
                    onClick={() => setGenderA("female")}
                    disabled={isLocked}
                    className={cn(
                      "px-2 py-2 rounded-md border text-xs font-medium transition-all",
                      genderA === "female"
                        ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                        : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                      isLocked && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    Fem.
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 block">
                  Voz pessoa B (direita)
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => setGenderB("male")}
                    disabled={isLocked}
                    className={cn(
                      "px-2 py-2 rounded-md border text-xs font-medium transition-all",
                      genderB === "male"
                        ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                        : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                      isLocked && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    Masc.
                  </button>
                  <button
                    onClick={() => setGenderB("female")}
                    disabled={isLocked}
                    className={cn(
                      "px-2 py-2 rounded-md border text-xs font-medium transition-all",
                      genderB === "female"
                        ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                        : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                      isLocked && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    Fem.
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Modo de áudio (só relevante em mixMode='avatar') */}
          {showAudioModeToggle && (
            <div>
              <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5" /> Como o avatar fala
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setAudioMode("veo_native")}
                  disabled={isLocked}
                  className={cn(
                    "px-3 py-3 rounded-lg border text-sm font-medium transition-all text-left",
                    audioMode === "veo_native"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold">Veo nativo · lip-sync</div>
                  <div className="text-[11px] text-white/40 mt-0.5">Voz gerada pelo Veo, lábios sincronizados.</div>
                </button>
                <button
                  onClick={() => setAudioMode("tts_overlay")}
                  disabled={isLocked}
                  className={cn(
                    "px-3 py-3 rounded-lg border text-sm font-medium transition-all text-left",
                    audioMode === "tts_overlay"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <div className="font-semibold">TTS por cima</div>
                  <div className="text-[11px] text-white/40 mt-0.5">Voz Onyx/Nova; avatar fica mudo. Sem lip-sync.</div>
                </button>
              </div>
            </div>
          )}

          {/* Voz: rótulo muda dependendo se vai virar TTS Onyx/Nova ou instrução pro Veo */}
          {showSingleVoice && (
            <div>
              <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 block">
                {voiceLabel}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setGender("male")}
                  disabled={isLocked}
                  className={cn(
                    "px-4 py-3 rounded-lg border text-sm font-medium transition-all",
                    gender === "male"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {maleLabel}
                </button>
                <button
                  onClick={() => setGender("female")}
                  disabled={isLocked}
                  className={cn(
                    "px-4 py-3 rounded-lg border text-sm font-medium transition-all",
                    gender === "female"
                      ? "bg-violet-500/20 border-violet-500/50 text-violet-200"
                      : "bg-white/[0.02] border-white/[0.08] text-white/60 hover:bg-white/[0.05]",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {femaleLabel}
                </button>
              </div>
              {veoNativeMode && (
                <p className="text-[11px] text-white/30 mt-1.5">
                  Veo escolhe um timbre dentro do gênero pedido — pode variar entre takes.
                </p>
              )}
            </div>
          )}

          {/* Copy */}
          <div>
            <label className="text-xs uppercase tracking-wider text-white/50 font-medium mb-2 flex items-center justify-between">
              <span>Copy falada</span>
              <span className="text-white/30 normal-case tracking-normal">
                {copy.length} chars · ≈{Math.round(copy.split(/\s+/).filter(Boolean).length / 2.8)}s narrado
              </span>
            </label>
            {mixMode === "conversation" && avatarUrl && (
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => insertTagAtCursor("[A]")}
                  disabled={isLocked}
                  className={cn(
                    "px-2.5 py-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-200 text-xs font-mono hover:bg-violet-500/20 transition",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  + [A] esquerda
                </button>
                <button
                  onClick={() => insertTagAtCursor("[B]")}
                  disabled={isLocked}
                  className={cn(
                    "px-2.5 py-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-200 text-xs font-mono hover:bg-violet-500/20 transition",
                    isLocked && "opacity-50 cursor-not-allowed"
                  )}
                >
                  + [B] direita
                </button>
                <span className="text-[10px] text-white/30 ml-auto">Tag inicia uma nova fala</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={copy}
              onChange={(e) => setCopy(e.target.value)}
              disabled={isLocked}
              rows={8}
              placeholder={mixMode === "conversation"
                ? "[A] Voce viu o que aconteceu? [B] Vi sim, foi incrivel. [A] Tambem fiquei chocado."
                : COPY_EXAMPLES[0]}
              className="w-full bg-white/[0.02] border border-white/[0.08] rounded-lg px-4 py-3 text-white placeholder-white/20 text-sm leading-relaxed focus:outline-none focus:border-violet-500/40 resize-none disabled:opacity-60"
            />
            {mixMode === "conversation" && conversationPreview && (
              <div className={cn(
                "mt-2 rounded-md border px-3 py-2 text-xs",
                conversationInvalid
                  ? "border-amber-500/30 bg-amber-500/5 text-amber-300/80"
                  : "border-white/[0.08] bg-white/[0.02] text-white/60",
              )}>
                {conversationInvalid ? (
                  <span>⚠ Use ao menos uma fala de <strong>[A]</strong> e uma de <strong>[B]</strong> pra montar a conversa.</span>
                ) : (
                  <span>
                    🎬 <strong>{conversationPreview.takes}</strong> takes · <strong>{conversationPreview.aCount}</strong> falas de A · <strong>{conversationPreview.bCount}</strong> falas de B · ≈{conversationPreview.estimatedSecs}s
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-white/30 mt-1.5">
              {mixMode === "conversation"
                ? "Cada turno marcado com [A] ou [B] vira 1 take Veo com a mesma foto. Só a pessoa marcada mexe a boca."
                : avatarUrl
                  ? "A cada ~7.5s de fala geramos 1 take Veo 3 Fast com o avatar falando o trecho. Cada take parte da mesma foto."
                  : "A cada 8s de narração geramos 1 take Veo 3 Fast. A copy é sempre narrada por inteiro."}
            </p>
          </div>

          {/* Botão */}
          {phase === "idle" || phase === "error" ? (
            <Button
              onClick={handleSubmit}
              disabled={copy.trim().length < 20 || uploadingAvatar || conversationInvalid}
              className="w-full bg-violet-500 hover:bg-violet-600 text-white font-semibold py-6"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {mixMode === "conversation"
                ? "Gerar conversa entre os 2 avatares"
                : avatarUrl
                  ? "Gerar vídeo com avatar falando"
                  : "Gerar vídeo narrado"}
            </Button>
          ) : (
            <Button onClick={handleReset} variant="outline" className="w-full">
              {phase === "done" ? "Gerar outro" : "Cancelar"}
            </Button>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Status */}
      {(phase === "submitting" || phase === "polling") && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <div className="flex-1">
                <p className="text-white/90 text-sm font-medium">
                  {phase === "submitting"
                    ? "Gerando narração e disparando takes..."
                    : `${completed}/${total} takes prontos · ${pct}%`}
                </p>
                {narrationDuration !== null && (
                  <p className="text-white/40 text-xs">Narração de {narrationDuration.toFixed(1)}s</p>
                )}
              </div>
            </div>
            {total > 0 && (
              <div className="h-1 bg-white/[0.05] rounded overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            {segments.length > 0 && (
              <div className="space-y-1.5 mt-3">
                {segments.map((s) => (
                  <div key={s.index} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full mt-1 flex-shrink-0",
                        s.status === "COMPLETED" && (s.usedFallback ? "bg-amber-400" : "bg-emerald-400"),
                        s.status === "PROCESSING" && "bg-violet-400 animate-pulse",
                        s.status === "FAILED" && "bg-red-400"
                      )}
                    />
                    <span className="text-white/50 line-clamp-2 flex-1">{s.text}</span>
                    {s.usedFallback && (
                      <span className="text-amber-300/80 text-[10px] whitespace-nowrap" title="Filtro Vertex bloqueou a foto — take rodou com avatar genérico">
                        avatar genérico
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {segments.some((s) => s.usedFallback) && (
              <div className="mt-2 text-[11px] text-amber-300/80 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
                Alguns takes não conseguiram usar sua foto (filtro de segurança do Vertex). Eles foram gerados com avatar genérico falando o trecho. Tente uma foto frontal mais neutra se quiser todos com seu avatar.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Resultado */}
      {phase === "done" && finalUrl && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="p-5 space-y-3">
            <video
              src={finalUrl}
              controls
              className="w-full rounded-lg bg-black"
              style={{ aspectRatio: "9/16", maxHeight: "70vh" }}
            />
            <div className="flex gap-2">
              <Button onClick={handleDownload} disabled={downloading} className="flex-1">
                {downloading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Baixando...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Baixar MP4
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
