export type NarratorAudioMode = "veo_native" | "tts_overlay";
export type NarratorLanguageCode = "pt-BR" | "en" | "es";

export interface NarratorSegmentState {
  index: number;
  text: string;
  visualPrompt: string;
  opName: string | null;
  // QUEUED = aguardando last-frame do take anterior pra ser submetido (chaining).
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  videoUrl: string | null;
  errorMessage: string | null;
  // Quantas vezes esse take já foi re-submetido após bloqueio RAI (default 0).
  // Quando bate MAX_RAI_RETRIES, último retry cai pra text-only sem imagem.
  retryCount?: number;
  // Epoch ms da última submissão pro Veo. Usado pra detectar takes pendurados
  // (Vertex AI às vezes não retorna done=true mesmo após minutos). Reset a cada
  // resubmit. Permite stuck-retry sem confundir com retry RAI.
  lastSubmittedAt?: number;
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
  // Idioma detectado da copy. Aplicado aos prompts do Veo e à voz TTS.
  // Default "pt-BR" pra compatibilidade com jobs antigos sem esse campo.
  language?: NarratorLanguageCode;
  // null quando audioMode === "veo_native" (não tem TTS).
  narrationAudioUrl: string | null;
  narrationDurationSeconds: number;
  segments: NarratorSegmentState[];
  finalVideoUrl: string | null;
  finalErrorMessage: string | null;
  // Timestamp (ms epoch) de quando o assembly final começou. Usado pra evitar
  // re-entry — o polling roda a cada 8s e o assembly pode demorar 30-60s.
  // Se != null e < 5min atrás, polling não retrigger; se > 5min, assume travou
  // e libera pra nova tentativa.
  assemblyStartedAt?: number | null;
  // Quantas vezes o assembly final foi tentado. Se passar de 3, marca FAILED
  // definitivo (evita loop infinito quando ffmpeg trava persistentemente).
  assemblyAttempts?: number;
}
