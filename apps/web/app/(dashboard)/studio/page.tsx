"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { upload } from "@vercel/blob/client";
import {
  Loader2, Sparkles, Download, RefreshCw, Copy,
  Wand2, ImagePlus, X, AlertCircle, Plus, Send, ClipboardPaste, Shirt,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "setup" | "generating" | "results";
type InputMode = "text" | "copy" | "outfit";
type AspectRatio = "1:1" | "9:16" | "16:9" | "3:4" | "4:3";

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  showRegenForm: boolean;
  regenFeedback: string;
  regenerating: boolean;
  originalBody: Record<string, unknown>;
}

interface AddFormState {
  mode: InputMode;
  prompt: string;
  refImageUrl: string | null;
  refPreview: string | null;
  modifications: string;
  faceImageUrl: string | null;
  facePreview: string | null;
  outfitImageUrl: string | null;
  outfitPreview: string | null;
  phase: "idle" | "uploading" | "generating" | "uploading-face" | "uploading-outfit";
}

const BLANK_FORM: AddFormState = {
  mode: "text", prompt: "", refImageUrl: null, refPreview: null,
  modifications: "", faceImageUrl: null, facePreview: null,
  outfitImageUrl: null, outfitPreview: null, phase: "idle",
};

const ASPECT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: "9:16",  label: "9:16 — Vertical" },
  { value: "16:9",  label: "16:9 — Horizontal" },
  { value: "1:1",   label: "1:1 — Quadrado" },
  { value: "3:4",   label: "3:4 — Retrato" },
  { value: "4:3",   label: "4:3 — Paisagem" },
];

// ─── AddImageForm ─────────────────────────────────────────────────────────────

interface AddImageFormProps {
  form: AddFormState;
  onChange: (patch: Partial<AddFormState>) => void;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (v: AspectRatio) => void;
  onGenerate: () => void;
  showAspectRatio: boolean;
  compact?: boolean;
}

function AddImageForm({ form, onChange, aspectRatio, onAspectRatioChange, onGenerate, showAspectRatio, compact }: AddImageFormProps) {
  const fileInputRef    = useRef<HTMLInputElement>(null);
  const faceInputRef    = useRef<HTMLInputElement>(null);
  const outfitInputRef  = useRef<HTMLInputElement>(null);
  const outfitAvatarRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    onChange({ refPreview: URL.createObjectURL(file), phase: "uploading" });
    try {
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: "reference_image" });
      onChange({ refImageUrl: blob.url, phase: "idle" });
    } catch {
      toast.error("Falha ao fazer upload da imagem");
      onChange({ refPreview: null, phase: "idle" });
    }
  }, [onChange]);

  const handlePasteButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            await handleFile(new File([blob], `colado-${Date.now()}.png`, { type }));
            return;
          }
        }
      }
      toast.error("Nenhuma imagem na área de transferência");
    } catch {
      toast.error("Cole com Ctrl+V — o navegador bloqueou o acesso direto");
    }
  };

  // Ctrl+V global
  useEffect(() => {
    if (form.mode !== "copy" || !!form.refPreview) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) { void handleFile(f); return; }
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [form.mode, form.refPreview, handleFile]);

  const handleFaceFile = useCallback(async (file: File) => {
    onChange({ facePreview: URL.createObjectURL(file), phase: "uploading-face" });
    try {
      const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: "face_image" });
      onChange({ faceImageUrl: blob.url, phase: "idle" });
    } catch {
      toast.error("Falha ao fazer upload do rosto");
      onChange({ facePreview: null, faceImageUrl: null, phase: "idle" });
    }
  }, [onChange]);

  const handleOutfitFile = useCallback(async (file: File, field: "refImage" | "outfit") => {
    if (field === "refImage") {
      onChange({ refPreview: URL.createObjectURL(file), phase: "uploading" });
      try {
        const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: "avatar_image" });
        onChange({ refImageUrl: blob.url, phase: "idle" });
      } catch {
        toast.error("Falha ao fazer upload do avatar");
        onChange({ refPreview: null, refImageUrl: null, phase: "idle" });
      }
    } else {
      onChange({ outfitPreview: URL.createObjectURL(file), phase: "uploading-outfit" });
      try {
        const blob = await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: "outfit_image" });
        onChange({ outfitImageUrl: blob.url, phase: "idle" });
      } catch {
        toast.error("Falha ao fazer upload da roupa");
        onChange({ outfitPreview: null, outfitImageUrl: null, phase: "idle" });
      }
    }
  }, [onChange]);

  const busy = form.phase !== "idle";

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex gap-2 flex-wrap">
        {(["text", "copy", "outfit"] as InputMode[]).map(m => (
          <button key={m}
            onClick={() => onChange({ mode: m, refImageUrl: null, refPreview: null, outfitImageUrl: null, outfitPreview: null })}
            className={`flex-1 min-w-[80px] py-2 rounded-lg text-sm font-medium transition-all border ${
              form.mode === m
                ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                : "border-white/[0.08] text-white/40 hover:text-white/70 hover:bg-white/5"
            }`}
          >
            {m === "text"
              ? <><Sparkles className="w-4 h-4 inline mr-1.5" />Texto</>
              : m === "copy"
              ? <><Copy className="w-4 h-4 inline mr-1.5" />Copiar imagem</>
              : <><Shirt className="w-4 h-4 inline mr-1.5" />Trocar roupa</>}
          </button>
        ))}
      </div>

      {/* Text input */}
      {form.mode === "text" && (
        <div className="space-y-1.5">
          <Label className="text-white/60 text-xs uppercase tracking-wide">Descrição</Label>
          <textarea value={form.prompt} onChange={e => onChange({ prompt: e.target.value })}
            placeholder="Descreva qualquer imagem que quiser gerar, sem restrições..."
            rows={compact ? 3 : 4}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-violet-500/50 resize-none"
          />
        </div>
      )}

      {/* Copy: upload area */}
      {form.mode === "copy" && (
        <div className="space-y-2">
          <Label className="text-white/60 text-xs uppercase tracking-wide">Foto de referência</Label>
          {form.refPreview ? (
            <div className="relative rounded-lg overflow-hidden max-h-44">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={form.refPreview} alt="Ref" className="w-full object-cover max-h-44" />
              {form.phase === "uploading" && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 text-white animate-spin" />
                </div>
              )}
              {form.phase === "idle" && (
                <button onClick={() => { onChange({ refPreview: null, refImageUrl: null }); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center hover:bg-black/90">
                  <X className="w-3.5 h-3.5 text-white" />
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => fileInputRef.current?.click()}
                className="w-full h-20 rounded-lg border border-dashed border-white/20 flex flex-col items-center justify-center gap-2 text-white/40 hover:text-white/60 hover:border-white/30 transition-all">
                <ImagePlus className="w-5 h-5" />
                <span className="text-sm">Selecionar arquivo</span>
              </button>
              <button onClick={handlePasteButton}
                className="w-full py-2.5 rounded-lg border border-dashed border-white/20 flex items-center justify-center gap-2 text-white/40 hover:text-white/60 hover:border-violet-500/30 hover:bg-violet-500/5 transition-all">
                <ClipboardPaste className="w-4 h-4" />
                <span className="text-sm">Colar imagem (Ctrl+V)</span>
              </button>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
        </div>
      )}

      {/* Copy: modifications + face swap */}
      {form.mode === "copy" && form.refImageUrl && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs uppercase tracking-wide">
              O que quer mudar? <span className="text-white/25 normal-case">(deixe vazio para cópia exata)</span>
            </Label>
            <textarea value={form.modifications} onChange={e => onChange({ modifications: e.target.value })}
              placeholder="Ex: tire a roupa, mude o cabelo para loiro, adicione fundo de praia..."
              rows={2}
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-violet-500/50 resize-none"
            />
          </div>

          {/* Phenotype swap */}
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs uppercase tracking-wide">
              Trocar fenótipo <span className="text-white/25 normal-case">(rosto, cabelo, etnia — opcional)</span>
            </Label>
            {form.facePreview ? (
              <div className="flex items-center gap-3">
                <div className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={form.facePreview} alt="Rosto" className="w-full h-full object-cover" />
                  {form.phase === "uploading-face" && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-white animate-spin" />
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-xs text-white/60">Fenótipo carregado</p>
                  <button onClick={() => { onChange({ facePreview: null, faceImageUrl: null }); if (faceInputRef.current) faceInputRef.current.value = ""; }}
                    className="text-xs text-red-400/70 hover:text-red-400 underline mt-1">
                    Remover
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => faceInputRef.current?.click()}
                className="w-full py-2.5 rounded-lg border border-dashed border-white/15 flex items-center justify-center gap-2 text-white/35 hover:text-white/60 hover:border-violet-500/30 hover:bg-violet-500/5 transition-all">
                <Plus className="w-4 h-4" />
                <span className="text-sm">Enviar foto para copiar fenótipo</span>
              </button>
            )}
            <input ref={faceInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFaceFile(f); }} />
          </div>
        </div>
      )}

      {/* Outfit mode */}
      {form.mode === "outfit" && (
        <div className="space-y-4">
          {/* Avatar photo */}
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs uppercase tracking-wide">Foto do avatar</Label>
            {form.refPreview ? (
              <div className="relative rounded-lg overflow-hidden max-h-44">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={form.refPreview} alt="Avatar" className="w-full object-cover max-h-44" />
                {form.phase === "uploading" && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-white animate-spin" />
                  </div>
                )}
                {form.phase === "idle" && (
                  <button onClick={() => { onChange({ refPreview: null, refImageUrl: null }); if (outfitAvatarRef.current) outfitAvatarRef.current.value = ""; }}
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center hover:bg-black/90">
                    <X className="w-3.5 h-3.5 text-white" />
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <button onClick={() => outfitAvatarRef.current?.click()}
                  className="w-full h-16 rounded-lg border border-dashed border-white/20 flex items-center justify-center gap-2 text-white/40 hover:text-white/60 hover:border-white/30 transition-all">
                  <ImagePlus className="w-4 h-4" />
                  <span className="text-sm">Selecionar arquivo</span>
                </button>
                <button onClick={async () => {
                  try {
                    const items = await navigator.clipboard.read();
                    for (const item of items) {
                      for (const type of item.types) {
                        if (type.startsWith("image/")) {
                          const blob = await item.getType(type);
                          await handleOutfitFile(new File([blob], `avatar-${Date.now()}.png`, { type }), "refImage");
                          return;
                        }
                      }
                    }
                    toast.error("Nenhuma imagem na área de transferência");
                  } catch { toast.error("Cole com Ctrl+V — o navegador bloqueou o acesso direto"); }
                }}
                  className="w-full py-2 rounded-lg border border-dashed border-white/15 flex items-center justify-center gap-2 text-white/35 hover:text-white/60 hover:border-white/30 hover:bg-white/5 transition-all">
                  <ClipboardPaste className="w-4 h-4" />
                  <span className="text-sm">Colar imagem (Ctrl+V)</span>
                </button>
              </div>
            )}
            <input ref={outfitAvatarRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleOutfitFile(f, "refImage"); }} />
          </div>

          {/* Outfit photo */}
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs uppercase tracking-wide">Foto da roupa</Label>
            {form.outfitPreview ? (
              <div className="relative rounded-lg overflow-hidden max-h-44">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={form.outfitPreview} alt="Roupa" className="w-full object-cover max-h-44" />
                {form.phase === "uploading-outfit" && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-white animate-spin" />
                  </div>
                )}
                {form.phase === "idle" && (
                  <button onClick={() => { onChange({ outfitPreview: null, outfitImageUrl: null }); if (outfitInputRef.current) outfitInputRef.current.value = ""; }}
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center hover:bg-black/90">
                    <X className="w-3.5 h-3.5 text-white" />
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <button onClick={() => outfitInputRef.current?.click()}
                  className="w-full h-16 rounded-lg border border-dashed border-violet-500/20 flex items-center justify-center gap-2 text-violet-300/40 hover:text-violet-300/70 hover:border-violet-500/40 transition-all">
                  <Shirt className="w-4 h-4" />
                  <span className="text-sm">Selecionar arquivo</span>
                </button>
                <button onClick={async () => {
                  try {
                    const items = await navigator.clipboard.read();
                    for (const item of items) {
                      for (const type of item.types) {
                        if (type.startsWith("image/")) {
                          const blob = await item.getType(type);
                          await handleOutfitFile(new File([blob], `outfit-${Date.now()}.png`, { type }), "outfit");
                          return;
                        }
                      }
                    }
                    toast.error("Nenhuma imagem na área de transferência");
                  } catch { toast.error("Cole com Ctrl+V — o navegador bloqueou o acesso direto"); }
                }}
                  className="w-full py-2 rounded-lg border border-dashed border-violet-500/15 flex items-center justify-center gap-2 text-violet-300/35 hover:text-violet-300/60 hover:border-violet-500/30 hover:bg-violet-500/5 transition-all">
                  <ClipboardPaste className="w-4 h-4" />
                  <span className="text-sm">Colar imagem (Ctrl+V)</span>
                </button>
              </div>
            )}
            <input ref={outfitInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleOutfitFile(f, "outfit"); }} />
          </div>

          {/* Extra notes */}
          <div className="space-y-1.5">
            <Label className="text-white/60 text-xs uppercase tracking-wide">
              Ajustes extras <span className="text-white/25 normal-case">(opcional)</span>
            </Label>
            <textarea value={form.modifications} onChange={e => onChange({ modifications: e.target.value })}
              placeholder="Ex: fundo branco, pose em pé, sapatos iguais..."
              rows={2}
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-violet-500/50 resize-none"
            />
          </div>
        </div>
      )}

      {/* Aspect ratio */}
      {showAspectRatio && (
        <div className="space-y-1.5">
          <Label className="text-white/60 text-xs uppercase tracking-wide">Proporção</Label>
          <Select value={aspectRatio} onValueChange={v => onAspectRatioChange(v as AspectRatio)}>
            <SelectTrigger className="bg-white/[0.04] border-white/[0.08] text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#1a1a2e] border-white/10">
              {ASPECT_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value} className="text-white/80 focus:bg-white/10 focus:text-white">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* CTA */}
      {form.mode === "text" ? (
        <Button onClick={onGenerate} disabled={!form.prompt.trim() || busy}
          className="w-full bg-violet-600 hover:bg-violet-500 text-white">
          {form.phase === "generating"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Gerando...</>
            : <><Sparkles className="w-4 h-4 mr-2" />Gerar Imagem</>}
        </Button>
      ) : form.mode === "outfit" ? (
        <Button onClick={onGenerate} disabled={!form.refImageUrl || !form.outfitImageUrl || busy}
          className="w-full bg-violet-600 hover:bg-violet-500 text-white">
          {form.phase === "uploading" || form.phase === "uploading-outfit"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Enviando...</>
            : form.phase === "generating"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Gerando...</>
            : <><Shirt className="w-4 h-4 mr-2" />Trocar Roupa</>}
        </Button>
      ) : (
        <Button onClick={onGenerate} disabled={!form.refImageUrl || busy}
          className="w-full bg-violet-600 hover:bg-violet-500 text-white">
          {form.phase === "uploading"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Enviando...</>
            : form.phase === "generating"
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Gerando...</>
            : <><Sparkles className="w-4 h-4 mr-2" />Gerar Imagem</>}
        </Button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const SESSION_KEY = "studio-nano-session";

export default function StudioPage() {
  const [phase, setPhase]             = useState<Phase>("setup");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [form, setForm]               = useState<AddFormState>({ ...BLANK_FORM });
  const [images, setImages]           = useState<GeneratedImage[]>([]);
  const [showAddMore, setShowAddMore] = useState(false);
  const [addMoreForm, setAddMoreForm] = useState<AddFormState>({ ...BLANK_FORM });

  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Session persistence
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const { images: savedImages, phase: savedPhase, aspectRatio: savedAspect } = JSON.parse(saved) as { images: GeneratedImage[]; phase: Phase; aspectRatio: AspectRatio };
      if (savedImages?.length > 0) {
        setImages(savedImages);
        setPhase(savedPhase ?? "results");
        if (savedAspect) setAspectRatio(savedAspect);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === "setup" && images.length === 0) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ images, phase, aspectRatio })); } catch { /* ignore */ }
  }, [images, phase, aspectRatio]);

  const patchForm    = useCallback((patch: Partial<AddFormState>) => setForm(f => ({ ...f, ...patch })), []);
  const patchAddMore = useCallback((patch: Partial<AddFormState>) => setAddMoreForm(f => ({ ...f, ...patch })), []);

  async function generateImage(f: AddFormState, setF: (patch: Partial<AddFormState>) => void): Promise<GeneratedImage | null> {
    setF({ phase: "generating" });
    try {
      let body: Record<string, unknown>;
      let label: string;

      if (f.mode === "outfit") {
        body = { referenceImageUrl: f.refImageUrl!, outfitImageUrl: f.outfitImageUrl!, prompt: f.modifications.trim(), aspectRatio };
        label = f.modifications.trim() ? `Troca de roupa: ${f.modifications.trim()}` : "Troca de roupa";
      } else if (f.mode === "copy") {
        body = { referenceImageUrl: f.refImageUrl!, prompt: f.modifications.trim(), aspectRatio, ...(f.faceImageUrl ? { faceImageUrl: f.faceImageUrl } : {}) };
        label = f.modifications.trim() ? `Cópia com ajuste: ${f.modifications.trim()}` : "Cópia exata";
      } else {
        body = { prompt: f.prompt.trim(), aspectRatio };
        label = f.prompt.trim();
      }

      const res = await fetch("/api/generate-nsfw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) { toast.error(data.error ?? "Erro ao gerar imagem"); setF({ phase: "idle" }); return null; }
      setF({ phase: "idle" });
      return { id: uid(), url: data.url, prompt: label, showRegenForm: false, regenFeedback: "", regenerating: false, originalBody: body };
    } catch {
      toast.error("Erro de rede");
      setF({ phase: "idle" });
      return null;
    }
  }

  const handleGenerate = async () => {
    setPhase("generating");
    const img = await generateImage(form, patchForm);
    if (img) { setImages([img]); setPhase("results"); }
    else setPhase("setup");
  };

  const handleAddMoreGenerate = async () => {
    const img = await generateImage(addMoreForm, patchAddMore);
    if (img) {
      setImages(prev => [...prev, img]);
      setShowAddMore(false);
      setAddMoreForm({ ...BLANK_FORM });
      toast.success("Nova imagem adicionada!");
    }
  };

  const handleRegenerate = async (imgId: string) => {
    const img = images.find(i => i.id === imgId);
    if (!img) return;
    const feedback = img.regenFeedback.trim();
    const regenBody: Record<string, unknown> = feedback
      ? { ...img.originalBody, prompt: img.originalBody.prompt ? `${img.originalBody.prompt}. ${feedback}` : feedback, modifications: img.originalBody.modifications ? `${img.originalBody.modifications}. ${feedback}` : feedback }
      : { ...img.originalBody };

    setImages(prev => prev.map(i => i.id === imgId ? { ...i, regenerating: true, showRegenForm: false } : i));
    try {
      const res = await fetch("/api/generate-nsfw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(regenBody) });
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        toast.error(data.error ?? "Erro");
        setImages(prev => prev.map(i => i.id === imgId ? { ...i, regenerating: false } : i));
        return;
      }
      const newLabel = feedback ? `${img.prompt} · ${feedback}` : img.prompt;
      setImages(prev => prev.map(i =>
        i.id === imgId
          ? { ...i, url: data.url!, prompt: newLabel, regenerating: false, regenFeedback: "", originalBody: regenBody }
          : i
      ));
      toast.success("Imagem regenerada!");
    } catch {
      setImages(prev => prev.map(i => i.id === imgId ? { ...i, regenerating: false } : i));
    }
  };

  const handleSendToAnimate = () => {
    const params = images.map(i => `imageUrl=${encodeURIComponent(i.url)}`).join("&");
    window.location.href = `/animate?${params}`;
  };

  const reset = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setPhase("setup");
    setForm({ ...BLANK_FORM });
    setImages([]);
    setShowAddMore(false);
    setAddMoreForm({ ...BLANK_FORM });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-violet-400" /> Nano Sem Filtro
          </h1>
          <p className="text-white/50 mt-1 text-sm">Gemini sem restrições — nunca rejeita</p>
        </div>
        {phase !== "setup" && (
          <Button onClick={reset} variant="outline" size="sm" className="border-white/10 text-white/60 hover:bg-white/5">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Recomeçar
          </Button>
        )}
      </div>

      {/* Setup */}
      {phase === "setup" && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="pt-5">
            <AddImageForm
              form={form}
              onChange={patchForm}
              aspectRatio={aspectRatio}
              onAspectRatioChange={setAspectRatio}
              onGenerate={handleGenerate}
              showAspectRatio={true}
            />
          </CardContent>
        </Card>
      )}

      {/* Generating */}
      {phase === "generating" && (
        <Card className="bg-white/[0.03] border-white/[0.08]">
          <CardContent className="pt-5">
            <div className="flex flex-col items-center gap-3 py-10 text-white/40">
              <div className="w-10 h-10 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              <p className="text-sm">Gerando com Gemini...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {phase === "results" && images.length > 0 && (
        <div className="space-y-4">

          {/* Global actions */}
          <div className="flex gap-2">
            <Button onClick={() => { setShowAddMore(true); setAddMoreForm({ ...BLANK_FORM }); }}
              variant="outline" className="flex-1 border-white/10 text-white/70 hover:bg-white/5">
              <Plus className="w-4 h-4 mr-2" />Gerar mais
            </Button>
            <Button onClick={handleSendToAnimate}
              className="flex-1 bg-violet-600 hover:bg-violet-500 text-white">
              <Send className="w-4 h-4 mr-2" />
              {images.length > 1 ? `Animar todas (${images.length})` : "Animar"}
            </Button>
          </div>

          {/* Add more form */}
          {showAddMore && (
            <Card className="bg-violet-500/5 border-violet-500/20">
              <CardContent className="pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-violet-300">Nova imagem</p>
                  <button onClick={() => setShowAddMore(false)} className="text-white/30 hover:text-white/60">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {addMoreForm.phase === "generating" ? (
                  <div className="flex items-center gap-3 py-4 text-white/40">
                    <Loader2 className="w-5 h-5 animate-spin text-violet-400" />
                    <p className="text-sm">Gerando imagem...</p>
                  </div>
                ) : (
                  <AddImageForm
                    form={addMoreForm}
                    onChange={patchAddMore}
                    aspectRatio={aspectRatio}
                    onAspectRatioChange={setAspectRatio}
                    onGenerate={handleAddMoreGenerate}
                    showAspectRatio={false}
                    compact
                  />
                )}
              </CardContent>
            </Card>
          )}

          {/* Image cards */}
          {images.map((img, idx) => (
            <Card key={img.id} className="bg-white/[0.03] border-white/[0.08]">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/40">Imagem {idx + 1}</span>
                  <button onClick={() => setImages(prev => prev.filter(i => i.id !== img.id))}
                    className="text-white/20 hover:text-red-400 transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {img.regenerating ? (
                  <div className="w-full h-48 rounded-lg bg-white/[0.04] flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.url} alt={`Imagem ${idx + 1}`} className="w-full h-auto block rounded-lg bg-black/20" />
                )}

                <div className="flex gap-2">
                  <a href={img.url} download={`nano-${idx + 1}.png`} target="_blank" rel="noopener noreferrer" className="flex-1">
                    <Button variant="outline" size="sm" className="w-full border-white/10 text-white/60 hover:bg-white/5">
                      <Download className="w-3.5 h-3.5 mr-1.5" />Baixar
                    </Button>
                  </a>
                  <Button variant="outline" size="sm" disabled={img.regenerating}
                    onClick={() => setImages(prev => prev.map(i => i.id === img.id ? { ...i, showRegenForm: !i.showRegenForm } : i))}
                    className="flex-1 border-white/10 text-white/60 hover:bg-white/5">
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Regenerar
                  </Button>
                  <a href={`/animate?imageUrl=${encodeURIComponent(img.url)}`} className="flex-1">
                    <Button size="sm" className="w-full bg-violet-600 hover:bg-violet-500 text-white">
                      <Wand2 className="w-3.5 h-3.5 mr-1.5" />Animar
                    </Button>
                  </a>
                </div>

                {img.showRegenForm && (
                  <div className="space-y-2 pt-1 border-t border-white/[0.06]">
                    <div className="flex items-center gap-1.5 text-xs text-amber-400/80">
                      <AlertCircle className="w-3.5 h-3.5" />
                      O que ficou errado? <span className="text-white/30">(opcional)</span>
                    </div>
                    <textarea
                      value={img.regenFeedback}
                      onChange={e => setImages(prev => prev.map(i => i.id === img.id ? { ...i, regenFeedback: e.target.value } : i))}
                      placeholder="Ex: rosto distorcido, cores erradas..."
                      rows={2}
                      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-amber-500/40 resize-none"
                    />
                    <Button onClick={() => handleRegenerate(img.id)} size="sm"
                      className="w-full bg-amber-600 hover:bg-amber-500 text-white">
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Regenerar agora
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
