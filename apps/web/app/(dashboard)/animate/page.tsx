"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Loader2, Sparkles, Wand2, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Download, RefreshCw, Plus,
  X, Merge, ClipboardPaste, ArrowUp, ArrowDown,
  Save, FolderOpen, Trash2, ChevronRight,
} from "lucide-react";
import { VideoTrimmer } from "@/components/video-trimmer";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { mergeVideosClient } from "@/lib/merge-videos";

// ─── Types ────────────────────────────────────────────────────────────────────

const schema = z.object({
  aspectRatio: z.enum(["RATIO_16_9", "RATIO_9_16"]),
  resolution: z.enum(["SD_480", "HD_720", "FHD_1080"]),
  maxDuration: z.union([z.literal(4), z.literal(5), z.literal(8), z.literal(10), z.literal(12), z.literal(15)]),
});
type FormData = z.infer<typeof schema>;

type Phase = "setup" | "generating-prompts" | "review-prompts" | "animating" | "done";
type TakeStatus = "uploading" | "upload-error" | "pending" | "processing" | "rendering" | "completed" | "failed";
type AIModel = "seedance-1.5" | "veo3-fast" | "veo3-quality";

const MODEL_CONFIG: Record<AIModel, { label: string; subtitle: string; color: string; dot: string; api: "animate" | "animate-veo3"; durations: number[]; durationFixed: boolean }> = {
  "veo3-quality": { label: "Veo 3 Quality",      subtitle: "Google · Alta qualidade · ~8s fixo", color: "cyan",   dot: "bg-cyan-400",   api: "animate-veo3", durations: [8],        durationFixed: true  },
  "veo3-fast":    { label: "Veo 3 Fast",          subtitle: "Google · Rápido · ~8s fixo",         color: "blue",   dot: "bg-blue-400",   api: "animate-veo3", durations: [8],        durationFixed: true  },
  "seedance-1.5": { label: "SeedDance 1.5 Pro", subtitle: "ByteDance · Rápido · 4, 8 ou 12s",   color: "violet", dot: "bg-violet-400", api: "animate",      durations: [4, 8, 12], durationFixed: false },
};
const MODEL_ORDER: AIModel[] = ["veo3-fast", "veo3-quality", "seedance-1.5"];

interface Take {
  id: string;
  localUrl: string;
  fileName: string;
  uploadedUrl?: string;
  status: TakeStatus;
  progress: number;
  description: string;
  speech: string;          // what the avatar says — empty = total silence
  generatedPrompt?: string;
  jobId?: string;
  outputVideoUrl?: string;
  errorMessage?: string;
  model?: AIModel;
  regenFeedback?: string;
  trimStart: number;   // seconds to cut from start (default 0)
  trimEnd: number;     // seconds to cut from end (default 0)
  duration?: number;   // video duration in seconds (loaded from element)
  speed: number;       // playback speed multiplier (default 1)
}

const SPEED_PRESETS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 2];

async function uploadImageFile(file: File): Promise<string> {
  const blob = await upload(file.name, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    clientPayload: "input_image",
  });
  return blob.url;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const ANIMATE_SESSION_KEY = "animate-session";
const SAVED_SETUPS_KEY = "animate-saved-setups";

interface SavedSetup {
  id: string;
  savedAt: string;
  model: AIModel;
  formValues: FormData;
  takes: Array<{
    uploadedUrl: string;
    description: string;
    generatedPrompt: string;
    speech: string;
  }>;
}

export default function AnimatePage() {
  const searchParams = useSearchParams();
  const [takes, setTakes] = useState<Take[]>([]);
  const [phase, setPhase] = useState<Phase>("setup");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Merge state
  const [selectedModel, setSelectedModel] = useState<AIModel>("veo3-fast");

  const [regenTrigger, setRegenTrigger] = useState(0);
  const [mergeOrder, setMergeOrder] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState(0);
  const [mergeLabel, setMergeLabel] = useState("");
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [mergedCdnUrl, setMergedCdnUrl] = useState<string | null>(null); // permanent Vercel Blob URL for persistence
  const [mergedType, setMergedType] = useState("video/mp4");
  const [mergedSpeed, setMergedSpeed] = useState(1);
  const [speedingUp, setSpeedingUp] = useState(false);
  const [speedProgress, setSpeedProgress] = useState(0);

  const [savedSetups, setSavedSetups] = useState<SavedSetup[]>([]);
  const [showSavedSetups, setShowSavedSetups] = useState(false);

  // Load saved setups from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_SETUPS_KEY);
      if (raw) setSavedSetups(JSON.parse(raw) as SavedSetup[]);
    } catch { /* ignore */ }
  }, []);

  const saveCurrentSetup = () => {
    const toSave = takes.filter((t) => t.uploadedUrl && t.generatedPrompt);
    if (toSave.length === 0) return;
    const entry: SavedSetup = {
      id: `${Date.now()}`,
      savedAt: new Date().toLocaleString("pt-BR"),
      model: selectedModel,
      formValues,
      takes: toSave.map((t) => ({
        uploadedUrl: t.uploadedUrl!,
        description: t.description,
        generatedPrompt: t.generatedPrompt!,
        speech: t.speech,
      })),
    };
    const updated = [entry, ...savedSetups].slice(0, 10); // keep max 10
    setSavedSetups(updated);
    try { localStorage.setItem(SAVED_SETUPS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
    toast.success("Setup salvo!");
  };

  const restoreSetup = (setup: SavedSetup) => {
    const restored: Take[] = setup.takes.map((t) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      localUrl: t.uploadedUrl,
      fileName: t.uploadedUrl.split("/").pop() ?? "image",
      uploadedUrl: t.uploadedUrl,
      status: "pending" as TakeStatus,
      progress: 0,
      description: t.description,
      generatedPrompt: t.generatedPrompt,
      speech: t.speech,
      trimStart: 0,
      trimEnd: 0,
      speed: 1,
    }));
    setTakes(restored);
    setSelectedModel(setup.model);
    if (setup.formValues) {
      setValue("aspectRatio", setup.formValues.aspectRatio);
      setValue("resolution", setup.formValues.resolution);
      setValue("maxDuration", setup.formValues.maxDuration);
    }
    setPhase("review-prompts");
    setShowSavedSetups(false);
    toast.success("Setup restaurado!");
  };

  const deleteSetup = (id: string) => {
    const updated = savedSetups.filter((s) => s.id !== id);
    setSavedSetups(updated);
    try { localStorage.setItem(SAVED_SETUPS_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
  };

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const takesRef = useRef<Take[]>(takes);
  takesRef.current = takes;
  const imageInputRef = useRef<HTMLInputElement>(null);
  // Map of takeId → <video> element, used to sync playbackRate live in the preview
  const videoElRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  const { control, watch, setValue } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { aspectRatio: "RATIO_9_16", resolution: "HD_720", maxDuration: 4 },
  });
  const formValues = watch();

  // ── Pre-load images from URL params (e.g. from Nano Banana "Animar todas") ──
  useEffect(() => {
    const urls = searchParams.getAll("imageUrl");
    if (urls.length > 0) {
      // URL params take priority — clear any saved session and load from params
      try { localStorage.removeItem(ANIMATE_SESSION_KEY); } catch { /* ignore */ }
      const newTakes: Take[] = urls.map((url) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        localUrl: url,
        fileName: url.split("/").pop() ?? "image",
        uploadedUrl: url,
        status: "pending" as TakeStatus,
        progress: 0,
        description: "",
        speech: "",
        trimStart: 0,
        trimEnd: 0,
        speed: 1,
      }));
      setTakes(newTakes);
      return;
    }

    // No URL params — try to restore saved session
    try {
      const saved = localStorage.getItem(ANIMATE_SESSION_KEY);
      if (!saved) return;
      const s = JSON.parse(saved) as {
        takes: Take[]; phase: Phase; selectedModel: AIModel;
        formValues: FormData; mergeOrder: string[];
        mergedUrl: string | null; mergedType: string; mergedSpeed: number;
      };
      // Sanitize takes: fix blob URLs (dead after navigation) → use uploadedUrl
      const restoredTakes = (s.takes ?? [])
        .filter((t) => t.uploadedUrl) // skip takes that never finished uploading
        .map((t) => ({
          ...t,
          localUrl: t.uploadedUrl!, // blob URL is dead; use the persisted CDN URL
          // takes still processing → keep as-is so polling resumes
          // takes uploading → skip (filtered above)
        }));
      if (restoredTakes.length === 0 && !s.mergedUrl) return;
      setTakes(restoredTakes);
      setPhase(s.phase ?? "setup");
      setSelectedModel(s.selectedModel ?? "veo3-quality");
      if (s.formValues) {
        setValue("aspectRatio", s.formValues.aspectRatio);
        setValue("resolution", s.formValues.resolution);
        setValue("maxDuration", s.formValues.maxDuration);
      }
      if (s.mergeOrder) setMergeOrder(s.mergeOrder);
      if (s.mergedUrl) { setMergedUrl(s.mergedUrl); setMergedType(s.mergedType ?? "video/mp4"); }
      if (s.mergedSpeed) setMergedSpeed(s.mergedSpeed);
      // Resume polling if there are pending takes
      const hasProcessing = restoredTakes.some((t) => ["processing", "rendering"].includes(t.status));
      if (hasProcessing) setRegenTrigger((n) => n + 1);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Save state to localStorage on changes ──
  useEffect(() => {
    if (phase === "setup" && takes.length === 0) return;
    try {
      localStorage.setItem(ANIMATE_SESSION_KEY, JSON.stringify({
        takes, phase, selectedModel, formValues, mergeOrder,
        mergedUrl: mergedCdnUrl ?? mergedUrl, // prefer CDN URL (survives reload) over local blob URL
        mergedType, mergedSpeed,
      }));
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takes, phase, selectedModel, mergeOrder, mergedUrl, mergedType, mergedSpeed]);


  // ── Add images ──

  const handleImageFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;

    const newTakes: Take[] = arr.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      localUrl: URL.createObjectURL(file),
      fileName: file.name,
      status: "uploading" as TakeStatus,
      progress: 0,
      description: "",
      speech: "",
      trimStart: 0,
      trimEnd: 0,
      speed: 1,
    }));
    setTakes((prev) => [...prev, ...newTakes]);

    await Promise.all(
      arr.map(async (file, i) => {
        const take = newTakes[i];
        try {
          const url = await uploadImageFile(file);
          setTakes((prev) => prev.map((t) => t.id === take.id ? { ...t, status: "pending", uploadedUrl: url } : t));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Erro no upload";
          toast.error(`Falha ao enviar imagem: ${msg}`);
          setTakes((prev) => prev.map((t) =>
            t.id === take.id ? { ...t, status: "upload-error", errorMessage: msg } : t
          ));
        }
      })
    );
  }, []);

  // Global Ctrl+V paste listener — captures images pasted anywhere on the page
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (phase !== "setup") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      void handleImageFiles(dt.files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [phase, handleImageFiles]);

  // Paste button — reads clipboard via Clipboard API (requires user gesture)
  const handlePasteButton = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const file = new File([blob], `colado-${Date.now()}.png`, { type });
            const dt = new DataTransfer();
            dt.items.add(file);
            await handleImageFiles(dt.files);
            return;
          }
        }
      }
      toast.error("Nenhuma imagem encontrada na área de transferência");
    } catch {
      toast.error("Cole com Ctrl+V — o navegador bloqueou o acesso direto à área de transferência");
    }
  };

  const removeTake = (id: string) => {
    setTakes((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t) URL.revokeObjectURL(t.localUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const downloadFile = async (url: string, filename: string) => {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Keep mergeOrder in sync: add newly completed takes, preserve existing order
  const completedIds = takes.filter((t) => t.status === "completed" && t.outputVideoUrl).map((t) => t.id);
  const orderedCompleted = [
    ...mergeOrder.filter((id) => completedIds.includes(id)),
    ...completedIds.filter((id) => !mergeOrder.includes(id)),
  ];
  if (orderedCompleted.join(",") !== mergeOrder.join(",")) {
    setMergeOrder(orderedCompleted);
  }

  const moveUp = (id: string) => setMergeOrder((prev) => {
    const idx = prev.indexOf(id);
    if (idx <= 0) return prev;
    const next = [...prev];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    return next;
  });

  const moveDown = (id: string) => setMergeOrder((prev) => {
    const idx = prev.indexOf(id);
    if (idx < 0 || idx >= prev.length - 1) return prev;
    const next = [...prev];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    return next;
  });

  const updateTrim = (id: string, field: "trimStart" | "trimEnd", value: number) =>
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, [field]: value } : t));

  const updateDuration = (id: string, duration: number) =>
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, duration } : t));

  const updateDescription = (id: string, description: string) => {
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, description } : t));
  };

  const updateSpeech = (id: string, speech: string) => {
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, speech } : t));
  };

  const updateRegenFeedback = (id: string, regenFeedback: string) => {
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, regenFeedback } : t));
  };

  const updateSpeed = (id: string, speed: number) => {
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, speed } : t));
    // Also update the live preview element immediately
    const el = videoElRefs.current.get(id);
    if (el) el.playbackRate = speed;
  };

  const updateGeneratedPrompt = (id: string, generatedPrompt: string) => {
    setTakes((prev) => prev.map((t) => t.id === id ? { ...t, generatedPrompt } : t));
  };

  // ── Step 1: Generate prompts (one per take) ──

  const handleGeneratePrompts = async () => {
    const ready = takes.filter((t) => t.uploadedUrl && t.description.trim());
    if (ready.length === 0) {
      toast.error("Preencha a descrição de pelo menos um take.");
      return;
    }

    setPhase("generating-prompts");

    try {
      // Send all descriptions in one batch so the AI can design a seamless loop
      const res = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptions: ready.map((t) => t.description),
          speechTexts: ready.map((t) => t.speech ?? ""),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.prompts) {
        toast.error(data.error ?? "Erro ao gerar prompts");
        setPhase("review-prompts");
        return;
      }

      setTakes((prev) =>
        prev.map((t) => {
          const idx = ready.findIndex((r) => r.id === t.id);
          if (idx === -1) return t;
          return { ...t, generatedPrompt: data.prompts[idx] };
        })
      );
    } catch {
      toast.error("Erro ao gerar prompts");
    }

    setPhase("review-prompts");
  };

  // ── Step 2: Animate all takes ──

  const handleAnimate = async () => {
    const ready = takes.filter((t) => t.uploadedUrl && t.generatedPrompt?.trim());
    if (ready.length === 0) return;

    const cfg = MODEL_CONFIG[selectedModel];
    const apiEndpoint = `/api/${cfg.api}`;

    const results = await Promise.allSettled(
      ready.map((take) =>
        fetch(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inputImageUrl: take.uploadedUrl,
            generatedPrompt: take.generatedPrompt,
            promptText: take.description,
            aspectRatio: formValues.aspectRatio,
            resolution: formValues.resolution,
            maxDuration: formValues.maxDuration,
            model: selectedModel,
          }),
        }).then((r) => r.json())
      )
    );

    results.forEach((result, i) => {
      const take = ready[i];
      if (result.status === "fulfilled" && result.value?.id) {
        setTakes((prev) => prev.map((t) =>
          t.id === take.id ? { ...t, jobId: result.value.id, status: "processing", progress: 10, model: selectedModel } : t
        ));
      } else {
        const msg = result.status === "rejected" ? result.reason?.message : result.value?.error;
        setTakes((prev) => prev.map((t) =>
          t.id === take.id ? { ...t, status: "failed", errorMessage: msg ?? "Falha ao criar job" } : t
        ));
      }
    });

    setPhase("animating");
    toast.success(`Animando ${ready.length} take${ready.length > 1 ? "s" : ""} com ${MODEL_CONFIG[selectedModel].label}!`);
  };

  // ── Regenerate a single take ──
  // Without feedback: resubmits the EXACT same prompt/params (faithful copy)
  // With feedback: adjusts only the fields the user asked to change

  const handleRegenerateTake = async (take: Take) => {
    const feedback = take.regenFeedback?.trim() ?? "";
    const model = selectedModel; // always use currently selected model so user can switch before retrying
    const cfg = MODEL_CONFIG[model];
    const apiEndpoint = `/api/${cfg.api}`;

    // Optimistically mark as processing
    setTakes((prev) => prev.map((t) =>
      t.id === take.id ? { ...t, status: "processing", progress: 10, errorMessage: undefined, outputVideoUrl: undefined } : t
    ));

    // Build the prompt to use:
    // - No feedback → use the EXACT existing generatedPrompt unchanged
    // - With feedback → ask GPT to adjust ONLY what the feedback requests, keeping everything else
    let newPrompt = take.generatedPrompt ?? "";
    if (feedback && take.generatedPrompt) {
      try {
        const res = await fetch("/api/generate-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            descriptions: [feedback],           // feedback = what to change
            existingPrompts: [take.generatedPrompt], // original JSON to preserve
            speechTexts: [take.speech ?? ""],
          }),
        });
        const data = await res.json() as { prompts?: string[] };
        if (res.ok && data.prompts?.[0]) {
          newPrompt = data.prompts[0];
          setTakes((prev) => prev.map((t) =>
            t.id === take.id ? { ...t, generatedPrompt: newPrompt, regenFeedback: "" } : t
          ));
        }
      } catch { /* keep existing prompt on error */ }
    }

    // Submit to animation API with the same original params
    try {
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputImageUrl: take.uploadedUrl,
          generatedPrompt: newPrompt,
          promptText: take.description,
          aspectRatio: formValues.aspectRatio,
          resolution: formValues.resolution,
          maxDuration: formValues.maxDuration,
          model,
        }),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (res.ok && data?.id) {
        setTakes((prev) => prev.map((t) =>
          t.id === take.id ? { ...t, jobId: data.id, status: "processing", progress: 10 } : t
        ));
        setRegenTrigger((n) => n + 1);
      } else {
        setTakes((prev) => prev.map((t) =>
          t.id === take.id ? { ...t, status: "failed", errorMessage: data.error ?? "Falha ao criar job" } : t
        ));
      }
    } catch (err) {
      setTakes((prev) => prev.map((t) =>
        t.id === take.id ? { ...t, status: "failed", errorMessage: err instanceof Error ? err.message : "Erro" } : t
      ));
    }
  };

  // ── Polling ──

  useEffect(() => {
    if (phase !== "animating" && phase !== "done") return;

    pollRef.current = setInterval(async () => {
      const current = takesRef.current;
      const pending = current.filter((t) => t.jobId && !["completed", "failed"].includes(t.status));

      if (pending.length === 0) {
        clearInterval(pollRef.current!);
        if (phase === "animating") setPhase("done");
        return;
      }

      await Promise.all(pending.map(async (take) => {
        try {
          const takeApiPath = take.model ? MODEL_CONFIG[take.model]?.api ?? "animate" : "animate";
          const pollUrl = `/api/${takeApiPath}/${take.jobId}`;
          const res = await fetch(pollUrl);
          if (!res.ok) return;
          const data = await res.json();
          const newStatus: TakeStatus =
            data.status === "COMPLETED" ? "completed"
            : data.status === "FAILED" ? "failed"
            : data.status === "RENDERING" ? "rendering"
            : "processing";
          setTakes((prev) => prev.map((t) =>
            t.id === take.id ? {
              ...t,
              status: newStatus,
              progress: newStatus === "completed" ? 100 : newStatus === "rendering" ? 75 : 45,
              outputVideoUrl: data.outputVideoUrl ?? t.outputVideoUrl,
              errorMessage: data.errorMessage ?? t.errorMessage,
            } : t
          ));
        } catch { /* ignore */ }
      }));
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // regenTrigger restarts polling when user regenerates a take from "done" phase
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, regenTrigger]);

  // ── Merge ──

  const handleMerge = async () => {
    const allCompleted = takesRef.current.filter((t) => t.status === "completed" && t.outputVideoUrl);
    const orderedIds = mergeOrder.filter((id) => allCompleted.some((t) => t.id === id));
    const completed = orderedIds.map((id) => allCompleted.find((t) => t.id === id)!);
    if (completed.length < 2) return;

    setMerging(true);
    setMergeProgress(0);
    setMergedUrl(null);

    try {
      setMergeLabel("Baixando vídeos...");
      setMergeProgress(5);
      const files = await Promise.all(completed.map(async (take, i) => {
        const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(take.outputVideoUrl!)}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`Falha ao baixar take ${i + 1}`);
        const blob = await res.blob();
        return new File([blob], `take-${i + 1}.mp4`, { type: blob.type || "video/mp4" });
      }));

      const trims = completed.map((t) => ({ start: t.trimStart, end: t.trimEnd }));
      const speeds = completed.map((t) => t.speed ?? 1);

      const blob = await mergeVideosClient(files, (pct, label) => {
        setMergeProgress(pct);
        setMergeLabel(label);
      }, trims, speeds);

      const url = URL.createObjectURL(blob);
      setMergedType(blob.type);
      setMergedUrl(url);
      setMergeProgress(100);
      toast.success("Vídeos juntados com sucesso!");

      // Save to history in background (include individual take URLs for re-joining later)
      try {
        const fd = new FormData();
        fd.append("file", new File([blob], "merged.mp4", { type: "video/mp4" }));
        fd.append("inputImageUrl", completed[0]?.uploadedUrl ?? completed[0]?.localUrl ?? "");
        fd.append("takeCount", String(completed.length));
        fd.append("takeVideoUrls", JSON.stringify(completed.map((t) => t.outputVideoUrl)));
        const saveRes = await fetch("/api/save-merged-video", { method: "POST", body: fd });
        if (saveRes.ok) {
          const saveData = await saveRes.json() as { url?: string };
          if (saveData.url) setMergedCdnUrl(saveData.url);
        }
      } catch {
        // non-blocking — history save failure shouldn't break the flow
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao juntar vídeos");
    } finally {
      setMerging(false);
    }
  };

  // Download merged video — applies speed if != 1 by re-encoding via canvas
  const handleDownloadMerged = async () => {
    if (!mergedUrl) return;
    const ext = mergedType.includes("mp4") ? "mp4" : "webm";

    if (mergedSpeed === 1) {
      // No speed change — download directly
      await downloadFile(mergedUrl, `animacao_completa.${ext}`);
      return;
    }

    // Re-encode at target speed
    setSpeedingUp(true);
    setSpeedProgress(0);
    try {
      const res = await fetch(mergedUrl);
      const blob = await res.blob();
      const file = new File([blob], `merged.${ext}`, { type: mergedType });
      const sped = await mergeVideosClient(
        [file],
        (pct, _label) => setSpeedProgress(pct),
        undefined,
        [mergedSpeed]
      );
      const url = URL.createObjectURL(sped);
      await downloadFile(url, `animacao_${mergedSpeed}x.${ext}`);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao aplicar velocidade");
    } finally {
      setSpeedingUp(false);
      setSpeedProgress(0);
    }
  };

  const reset = () => {
    try { localStorage.removeItem(ANIMATE_SESSION_KEY); } catch { /* ignore */ }
    setMergedCdnUrl(null);
    takes.forEach((t) => { try { URL.revokeObjectURL(t.localUrl); } catch { /* ignore */ } });
    if (mergedUrl) { try { URL.revokeObjectURL(mergedUrl); } catch { /* ignore */ } }
    setTakes([]);
    setPhase("setup");
    setMergeOrder([]);
    setMergedUrl(null);
    setMergeProgress(0);
    setMergedSpeed(1);
    videoElRefs.current.clear();
  };

  const readyTakes = takes.filter((t) => t.uploadedUrl && t.description.trim());
  const completedTakes = takes.filter((t) => t.status === "completed");
  const mergedExt = mergedType.includes("mp4") ? "mp4" : "webm";

  // ─── Done ───

  if (phase === "done") {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Takes Gerados</h1>
            <p className="text-white/50 mt-1">
              {completedTakes.length} de {takes.filter(t => t.jobId).length} take{takes.length > 1 ? "s" : ""} concluído{completedTakes.length !== 1 ? "s" : ""}
            </p>
          </div>
          <Button onClick={reset} variant="outline" className="border-white/10 text-white hover:bg-white/5">
            <RefreshCw className="w-4 h-4 mr-2" />Nova Animação
          </Button>
        </div>

        {/* Model selector — shown only when there are failed takes so user can retry with a different model */}
        {takes.some(t => t.status === "failed") && (
          <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20 space-y-3">
            <p className="text-xs font-semibold text-red-300 uppercase tracking-wide">Takes com falha — escolha o modelo e tente novamente</p>
            <div className="grid grid-cols-1 gap-2">
              {MODEL_ORDER.map((key) => { const cfg = MODEL_CONFIG[key];
                const isSelected = selectedModel === key;
                const borderColor = isSelected
                  ? cfg.color === "violet" ? "border-violet-500 bg-violet-500/10"
                  : cfg.color === "blue" ? "border-blue-500 bg-blue-500/10"
                  : "border-cyan-500 bg-cyan-500/10"
                  : "border-white/[0.08] bg-white/[0.03] hover:border-white/20";
                return (
                  <button key={key} type="button"
                    onClick={() => { setSelectedModel(key); setValue("maxDuration", MODEL_CONFIG[key].durations[0] as FormData["maxDuration"]); }}
                    className={`p-2.5 rounded-lg border-2 text-left transition-all ${borderColor}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isSelected ? cfg.dot : "bg-white/20"}`} />
                      <span className="text-sm font-semibold text-white">{cfg.label}</span>
                      <span className="text-xs text-white/40 ml-auto">{cfg.subtitle}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {takes.filter(t => t.jobId || t.status === "failed").map((take, i) => {
            const orderIdx = mergeOrder.indexOf(take.id);
            const maxTrim = Math.max(0, ((take.duration ?? 8) - 0.5) / 2);
            const trimmedDur = take.duration != null
              ? Math.max(0.5, take.duration - take.trimStart - take.trimEnd).toFixed(1)
              : null;
            return (
            <Card key={take.id} className="bg-white/[0.03] border-white/[0.08]">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <img src={take.localUrl} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white/80 truncate">
                      {orderIdx >= 0 ? `#${orderIdx + 1} · ` : ""}Take {i + 1}
                    </p>
                    <p className="text-xs text-white/40 truncate">{take.description}</p>
                  </div>
                  {orderIdx >= 0 && (
                    <div className="w-5 h-5 rounded-full bg-violet-600/80 flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0">
                      {orderIdx + 1}
                    </div>
                  )}
                  {take.status === "completed" && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  {take.status === "failed" && <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                </div>

                {take.status === "completed" && take.outputVideoUrl ? (
                  <>
                    <video
                      ref={(el) => {
                        if (el) {
                          videoElRefs.current.set(take.id, el);
                          el.playbackRate = take.speed ?? 1;
                        } else {
                          videoElRefs.current.delete(take.id);
                        }
                      }}
                      src={take.outputVideoUrl} controls loop
                      className="w-full rounded-lg bg-black aspect-video"
                      onLoadedMetadata={(e) => {
                        const el = e.target as HTMLVideoElement;
                        el.playbackRate = take.speed ?? 1;
                        updateDuration(take.id, el.duration);
                      }}
                    />

                    {/* Speed selector */}
                    <div className="space-y-2 p-2.5 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-white/50 flex items-center gap-1.5">⚡ Velocidade</span>
                        <span className="text-xs font-semibold text-violet-300">{(take.speed ?? 1).toFixed(2)}×</span>
                      </div>
                      {/* Preset buttons */}
                      <div className="flex gap-1 flex-wrap">
                        {SPEED_PRESETS.map((s) => (
                          <button
                            key={s}
                            onClick={() => updateSpeed(take.id, s)}
                            className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                              (take.speed ?? 1) === s
                                ? "bg-violet-600 text-white"
                                : "bg-white/[0.05] text-white/50 hover:bg-white/10 hover:text-white"
                            }`}
                          >
                            {s}×
                          </button>
                        ))}
                      </div>
                      {/* Custom input */}
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0.1}
                          max={10}
                          step={0.01}
                          value={take.speed ?? 1}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v) && v >= 0.1 && v <= 10) updateSpeed(take.id, v);
                          }}
                          className="w-20 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-violet-500/50"
                        />
                        <span className="text-xs text-white/30">× personalizado (0.1 – 10)</span>
                      </div>
                    </div>

                    {/* Trim controls */}
                    {take.duration != null && take.duration > 0.5 && (
                      <VideoTrimmer
                        duration={take.duration}
                        trimStart={take.trimStart}
                        trimEnd={take.trimEnd}
                        videoRef={{ current: videoElRefs.current.get(take.id) ?? null }}
                        onChange={(s, e) => { updateTrim(take.id, "trimStart", s); updateTrim(take.id, "trimEnd", e); }}
                      />
                    )}

                    <Button variant="outline" size="sm" className="w-full border-white/10 text-white hover:bg-white/5" onClick={() => void downloadFile(take.outputVideoUrl!, `take-${i + 1}.mp4`)}>
                      <Download className="w-3.5 h-3.5 mr-1.5" />Baixar Take {i + 1}
                    </Button>
                    <div className="space-y-2 pt-1 border-t border-white/[0.06]">
                      <textarea
                        value={take.regenFeedback ?? ""}
                        onChange={(e) => updateRegenFeedback(take.id, e.target.value)}
                        placeholder="O que quer mudar? (opcional)"
                        rows={2}
                        className="w-full bg-white/5 border border-white/10 rounded-lg p-2.5 text-xs text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-violet-500/50"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleRegenerateTake(take)}
                        variant="outline"
                        className="w-full border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
                      >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Regenerar
                      </Button>
                    </div>
                  </>
                ) : take.status === "failed" ? (
                  <>
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                      <p className="text-xs text-red-400">{take.errorMessage ?? "Falhou"}</p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleRegenerateTake(take)}
                      className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white"
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Tentar Novamente
                    </Button>
                  </>
                ) : (
                  <div className="flex items-center gap-2 p-3">
                    <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                    <span className="text-sm text-white/50">Gerando...</span>
                  </div>
                )}
              </CardContent>
            </Card>
            );
          })}
        </div>

        {/* ── Merge order panel — shown when 2+ takes are complete ── */}
        {completedTakes.length >= 2 && (
          <Card className="bg-violet-500/5 border-violet-500/20">
            <CardContent className="pt-5 space-y-4">

              {/* Order list */}
              {!merging && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-violet-300 uppercase tracking-wide flex items-center gap-2">
                    <Merge className="w-3.5 h-3.5" />Ordem de Junção
                  </p>
                  <div className="space-y-1.5">
                    {mergeOrder.map((id, idx) => {
                      const t = takes.find((x) => x.id === id);
                      if (!t) return null;
                      return (
                        <div key={id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                          {/* Big order number */}
                          <div className="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
                            {idx + 1}
                          </div>
                          {/* Thumbnail */}
                          <img src={t.localUrl} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                          {/* Description */}
                          <p className="text-xs text-white/70 flex-1 truncate">{t.description || t.fileName}</p>
                          {/* Move arrows */}
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              onClick={() => moveUp(id)}
                              disabled={idx === 0}
                              className="w-6 h-6 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => moveDown(id)}
                              disabled={idx === mergeOrder.length - 1}
                              className="w-6 h-6 rounded flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Merge progress */}
              {merging && (
                <>
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-4 h-4 text-violet-400 animate-spin flex-shrink-0" />
                    <span className="text-sm text-white/70">{mergeLabel}</span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all duration-300 rounded-full" style={{ width: `${mergeProgress}%` }} />
                  </div>
                  <p className="text-xs text-white/30">Não feche esta aba durante o processamento.</p>
                </>
              )}

              {/* Actions */}
              {!merging && (
                <Button
                  onClick={handleMerge}
                  className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white"
                >
                  <Merge className="w-4 h-4 mr-2" />
                  {mergedUrl ? "Juntar de Novo (nova ordem)" : `Juntar ${completedTakes.length} Takes`}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Merged result */}
        {mergedUrl && (
          <Card className="bg-white/[0.03] border-green-500/20">
            <CardHeader>
              <CardTitle className="text-white text-base flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-400" />Vídeo Final Pronto
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <video src={mergedUrl} controls className="w-full rounded-lg bg-black" />

              {/* Speed selector for merged video */}
              <div className="space-y-2 p-3 bg-white/[0.03] rounded-lg border border-white/[0.06]">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50 flex items-center gap-1.5">⚡ Velocidade ao baixar</span>
                  <span className="text-xs font-semibold text-violet-300">{mergedSpeed.toFixed(2)}×</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {SPEED_PRESETS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setMergedSpeed(s)}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                        mergedSpeed === s
                          ? "bg-violet-600 text-white"
                          : "bg-white/[0.05] text-white/50 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.01}
                    value={mergedSpeed}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v >= 0.1 && v <= 10) setMergedSpeed(v);
                    }}
                    className="w-20 bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-xs text-white text-center focus:outline-none focus:border-violet-500/50"
                  />
                  <span className="text-xs text-white/30">× personalizado (0.1 – 10)</span>
                </div>
                {mergedSpeed !== 1 && (
                  <p className="text-xs text-amber-400/70">
                    O vídeo será re-processado em {mergedSpeed}× antes do download.
                  </p>
                )}
              </div>

              {/* Speed progress bar */}
              {speedingUp && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin flex-shrink-0" />
                    <span className="text-xs text-white/60">Aplicando {mergedSpeed}×...</span>
                  </div>
                  <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all duration-300 rounded-full"
                      style={{ width: `${speedProgress}%` }}
                    />
                  </div>
                </div>
              )}

              <Button
                className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white"
                onClick={() => void handleDownloadMerged()}
                disabled={speedingUp}
              >
                {speedingUp
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processando...</>
                  : <><Download className="w-4 h-4 mr-2" />Baixar{mergedSpeed !== 1 ? ` em ${mergedSpeed}×` : " Vídeo Completo"}</>
                }
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ─── Animating ───

  if (phase === "animating") {
    const totalDone = takes.filter((t) => ["completed", "failed"].includes(t.status)).length;
    const withJob = takes.filter((t) => t.jobId).length;

    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Animando Takes</h1>
          <p className="text-white/50 mt-1">{totalDone} de {withJob} take{withJob > 1 ? "s" : ""} concluído{totalDone !== 1 ? "s" : ""}</p>
        </div>

        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 transition-all duration-700 rounded-full" style={{ width: `${withJob > 0 ? Math.round((totalDone / withJob) * 100) : 0}%` }} />
        </div>

        <div className="space-y-2">
          {takes.filter(t => t.jobId || t.status === "failed").map((take, i) => {
            const statusLabel: Record<string, string> = {
              processing: "Processando...", rendering: "Renderizando...",
              completed: "Concluído!", failed: "Falhou",
            };
            return (
              <div key={take.id} className={`p-3 rounded-lg bg-white/[0.03] border ${take.status === "failed" ? "border-red-500/30" : "border-white/[0.08]"}`}>
                <div className="flex items-center gap-3">
                  <img src={take.localUrl} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-medium text-white/70">Take {i + 1}</p>
                      <p className={`text-xs ${take.status === "failed" ? "text-red-400" : "text-white/40"}`}>{statusLabel[take.status] ?? take.status}</p>
                    </div>
                    <p className="text-xs text-white/30 truncate mb-1.5">{take.description}</p>
                    <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${take.status === "failed" ? "bg-red-500" : "bg-gradient-to-r from-violet-500 to-purple-500"}`}
                        style={{ width: `${take.progress}%` }}
                      />
                    </div>
                  </div>
                  {take.status === "completed" && <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  {take.status === "failed" && <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />}
                  {!["completed", "failed"].includes(take.status) && <Loader2 className="w-4 h-4 text-violet-400 animate-spin flex-shrink-0" />}
                </div>
                {take.status === "failed" && (
                  <div className="mt-2 flex items-center gap-2">
                    <p className="text-xs text-red-400/70 flex-1 truncate">{take.errorMessage ?? "Falhou"}</p>
                    <Button size="sm" variant="outline"
                      onClick={() => void handleRegenerateTake(take)}
                      className="h-6 px-2 text-xs border-white/10 text-white/60 hover:bg-white/5 hover:text-white flex-shrink-0"
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />Tentar
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Review Prompts ───

  if (phase === "review-prompts") {
    const withPrompt = takes.filter((t) => t.uploadedUrl && t.generatedPrompt);
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Revisar Prompts</h1>
          <p className="text-white/50 mt-1">Confira e edite o prompt de cada take antes de animar</p>
        </div>

        <div className="space-y-4">
          {takes.filter(t => t.uploadedUrl).map((take, i) => (
            <Card key={take.id} className="bg-white/[0.03] border-white/[0.08]">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-3">
                  <img src={take.localUrl} alt="" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-white">Take {i + 1}</p>
                    <p className="text-xs text-white/40">{take.description}</p>
                  </div>
                </div>
                {take.generatedPrompt ? (
                  <>
                    <textarea
                      value={take.generatedPrompt}
                      onChange={(e) => updateGeneratedPrompt(take.id, e.target.value)}
                      rows={4}
                      className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white/80 resize-none focus:outline-none focus:border-violet-500/50 leading-relaxed"
                    />
                    <p className="text-xs text-white/30">Prompt gerado pela IA — pode editar livremente.</p>
                  </>
                ) : (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                    <p className="text-xs text-red-400">Erro ao gerar prompt para este take.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex gap-3">
          <Button type="button" onClick={() => setPhase("setup")} variant="outline" className="border-white/10 text-white hover:bg-white/5">Voltar</Button>
          <Button
            type="button"
            onClick={saveCurrentSetup}
            variant="outline"
            disabled={withPrompt.length === 0}
            className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
            title="Salvar imagens e prompts para reutilizar depois"
          >
            <Save className="w-4 h-4 mr-1.5" />Salvar
          </Button>
          <Button
            type="button"
            onClick={handleAnimate}
            disabled={withPrompt.length === 0}
            className="flex-1 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-11"
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Animar {withPrompt.length} Take{withPrompt.length > 1 ? "s" : ""} com {MODEL_CONFIG[selectedModel].label}
          </Button>
        </div>
      </div>
    );
  }

  // ─── Setup ───

  const allUploaded = takes.length > 0 && takes.every((t) => t.status !== "uploading");

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Animar por Texto</h1>
          <p className="text-white/50 mt-1">Cada foto tem sua própria descrição e prompt de animação</p>
        </div>
        {takes.length > 0 && (
          <Button onClick={reset} variant="outline" size="sm" className="border-white/10 text-white/60 hover:bg-white/5">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Recomeçar
          </Button>
        )}
      </div>

      {/* Saved setups */}
      {savedSetups.length > 0 && (
        <div className="rounded-xl border border-white/[0.08] overflow-hidden">
          <button
            onClick={() => setShowSavedSetups((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.05] transition-colors"
          >
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-medium text-white/80">Setups Salvos</span>
              <span className="text-xs bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-full">{savedSetups.length}</span>
            </div>
            <ChevronRight className={`w-4 h-4 text-white/40 transition-transform ${showSavedSetups ? "rotate-90" : ""}`} />
          </button>
          {showSavedSetups && (
            <div className="divide-y divide-white/[0.05]">
              {savedSetups.map((setup) => (
                <div key={setup.id} className="flex items-center gap-3 px-4 py-3 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/80 truncate">
                      {setup.takes.length} take{setup.takes.length !== 1 ? "s" : ""} · {MODEL_CONFIG[setup.model].label}
                    </p>
                    <p className="text-xs text-white/30">{setup.savedAt}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => restoreSetup(setup)}
                    className="h-7 px-3 text-xs bg-violet-600/80 hover:bg-violet-600 text-white flex-shrink-0"
                  >
                    Restaurar
                  </Button>
                  <button
                    onClick={() => deleteSetup(setup.id)}
                    className="p-1.5 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Model selector */}
      <div className="space-y-2">
        <p className="text-xs text-white/40 font-medium uppercase tracking-wide">Modelo de IA</p>
        <div className="grid grid-cols-1 gap-2">
          {MODEL_ORDER.map((key) => { const cfg = MODEL_CONFIG[key];
            const isSelected = selectedModel === key;
            const borderColor = isSelected
              ? cfg.color === "violet" ? "border-violet-500 bg-violet-500/10"
              : cfg.color === "purple" ? "border-purple-500 bg-purple-500/10"
              : cfg.color === "fuchsia" ? "border-fuchsia-500 bg-fuchsia-500/10"
              : cfg.color === "blue" ? "border-blue-500 bg-blue-500/10"
              : "border-cyan-500 bg-cyan-500/10"
              : "border-white/[0.08] bg-white/[0.03] hover:border-white/20";
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedModel(key);
                  setValue("maxDuration", MODEL_CONFIG[key].durations[0] as FormData["maxDuration"]);
                }}
                className={`p-3 rounded-xl border-2 text-left transition-all ${borderColor}`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isSelected ? cfg.dot : "bg-white/20"}`} />
                  <span className="text-sm font-semibold text-white">{cfg.label}</span>
                  <span className="text-xs text-white/40 ml-auto">{cfg.subtitle}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Takes list */}
      <div className="space-y-3">
        {takes.map((take, i) => (
          <Card key={take.id} className="bg-white/[0.03] border-white/[0.08]">
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="relative flex-shrink-0">
                  <img src={take.localUrl} alt="" className="w-16 h-16 rounded-lg object-cover border border-white/10" />
                  {take.status === "uploading" && (
                    <div className="absolute inset-0 rounded-lg bg-black/60 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
                    </div>
                  )}
                  {take.status === "upload-error" && (
                    <div className="absolute inset-0 rounded-lg bg-red-900/60 flex items-center justify-center">
                      <XCircle className="w-4 h-4 text-red-400" />
                    </div>
                  )}
                  <div className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white">{i + 1}</div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-white/50 truncate">{take.fileName}</p>
                    <button onClick={() => removeTake(take.id)} className="p-1 rounded text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors ml-2">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <textarea
                    value={take.description}
                    onChange={(e) => updateDescription(take.id, e.target.value)}
                    placeholder={`Descreva o que o avatar do take ${i + 1} vai fazer...`}
                    rows={3}
                    disabled={take.status === "uploading"}
                    className="w-full bg-white/5 border border-white/10 rounded-lg p-2.5 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
                  />
                  <div className="mt-2 space-y-1">
                    <label className="text-xs text-white/35 flex items-center gap-1.5">
                      <span className="text-white/50">💬</span>
                      O que o avatar vai falar?
                      <span className="text-white/25">(deixe vazio para silêncio total)</span>
                    </label>
                    <input
                      type="text"
                      value={take.speech ?? ""}
                      onChange={(e) => updateSpeech(take.id, e.target.value)}
                      placeholder="Ex: Olá, bem-vindo ao meu canal!"
                      disabled={take.status === "uploading"}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {/* Add images buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="p-4 rounded-xl border-2 border-dashed border-white/[0.10] flex items-center justify-center gap-2 text-white/40 hover:text-white/70 hover:border-violet-500/40 hover:bg-violet-500/5 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span className="text-sm">{takes.length === 0 ? "Selecionar foto" : "Adicionar foto"}</span>
          </button>
          <button
            type="button"
            onClick={handlePasteButton}
            className="p-4 rounded-xl border-2 border-dashed border-white/[0.10] flex items-center justify-center gap-2 text-white/40 hover:text-white/70 hover:border-violet-500/40 hover:bg-violet-500/5 transition-all"
          >
            <ClipboardPaste className="w-4 h-4" />
            <span className="text-sm">Colar (Ctrl+V)</span>
          </button>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleImageFiles(e.target.files)}
        />
      </div>

      {takes.length === 0 && (
        <p className="text-center text-xs text-white/25">Cada foto vira um take — cada take tem sua própria descrição e prompt</p>
      )}

      {/* Settings */}
      <Card className="bg-white/[0.03] border-white/[0.08]">
        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full p-5 flex items-center justify-between text-left">
          <span className="text-white/70 text-sm">Configurações de saída <span className="text-white/30 text-xs">(aplicado em todos os takes)</span></span>
          {showAdvanced ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
        </button>
        {showAdvanced && (
          <CardContent className="pt-0 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-white/60 text-xs">Proporção</Label>
                <Controller name="aspectRatio" control={control} render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="RATIO_9_16">9:16 Vertical</SelectItem>
                      <SelectItem value="RATIO_16_9">16:9 Horizontal</SelectItem>
                    </SelectContent>
                  </Select>
                )} />
              </div>
              <div className="space-y-2">
                <Label className="text-white/60 text-xs">Resolução</Label>
                <Controller name="resolution" control={control} render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SD_480">480p (SD)</SelectItem>
                      <SelectItem value="HD_720">720p (HD)</SelectItem>
                      <SelectItem value="FHD_1080">1080p (Full HD)</SelectItem>
                    </SelectContent>
                  </Select>
                )} />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-white/60 text-xs">Duração</Label>
              {MODEL_CONFIG[selectedModel].durationFixed ? (
                <p className="text-sm text-white/40 bg-white/5 border border-white/10 rounded-lg px-3 py-2">~8s (fixo pelo modelo)</p>
              ) : (
                <Controller name="maxDuration" control={control} render={({ field }) => (
                  <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MODEL_CONFIG[selectedModel].durations.map((d) => (
                        <SelectItem key={d} value={String(d)}>{d} segundos</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )} />
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Generate prompts button */}
      <Button
        type="button"
        onClick={handleGeneratePrompts}
        disabled={phase === "generating-prompts" || !allUploaded || readyTakes.length === 0}
        className="w-full bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white h-12 text-base font-medium disabled:opacity-40"
      >
        {phase === "generating-prompts" ? (
          <><Loader2 className="w-5 h-5 animate-spin mr-2" />Gerando prompts...</>
        ) : (
          <><Wand2 className="w-5 h-5 mr-2" />
            Gerar Prompt{readyTakes.length > 1 ? `s para ${readyTakes.length} Takes` : readyTakes.length === 1 ? " para 1 Take" : ""} · {MODEL_CONFIG[selectedModel].label}
          </>
        )}
      </Button>

      {readyTakes.length === 0 && takes.length > 0 && (
        <p className="text-center text-xs text-white/30">Preencha a descrição de pelo menos um take para continuar</p>
      )}
    </div>
  );
}
