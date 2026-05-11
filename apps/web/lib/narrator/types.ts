export type NarratorAudioMode = "veo_native" | "tts_overlay";

export interface NarratorSegmentState {
  index: number;
  text: string;
  visualPrompt: string;
  opName: string | null;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  videoUrl: string | null;
  errorMessage: string | null;
  // Quantas vezes esse take já foi re-submetido após bloqueio RAI (default 0).
  // Quando bate MAX_RAI_RETRIES, último retry cai pra text-only sem imagem.
  retryCount?: number;
  // True quando o take rodou em fallback text-only (sem foto do avatar) porque
  // todos os retries com imagem foram bloqueados pelo filtro RAI. UI deve
  // sinalizar isso pro user.
  usedFallback?: boolean;
}

export interface NarratorJobState {
  kind: "narrator-v1";
  copy: string;
  voice: string;
  gender: "male" | "female";
  // Quando avatar não é usado, narration sempre é TTS overlay.
  // Quando avatar é usado, audioMode decide se Veo gera áudio nativo (lip-sync)
  // ou se fica mudo e TTS é sobreposta.
  avatarImageUrl: string | null;
  audioMode: NarratorAudioMode;
  // null quando audioMode === "veo_native" (não tem TTS).
  narrationAudioUrl: string | null;
  narrationDurationSeconds: number;
  segments: NarratorSegmentState[];
  finalVideoUrl: string | null;
  finalErrorMessage: string | null;
}
