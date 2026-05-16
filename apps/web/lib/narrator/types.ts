export type NarratorAudioMode = "veo_native" | "tts_overlay";
export type NarratorLanguageCode = "pt-BR" | "en" | "es";
// Estilo visual de cada take. Default 'avatar' quando há foto; 'broll' quando não.
// 'mixed' (no NarratorJobState) é o ROTEIRO geral que mistura os 3 estilos.
// 'conversation' = take de 2 pessoas no mesmo quadro, só o speaker fala.
export type NarratorSegmentStyle = "avatar" | "broll" | "avatar_cutout" | "conversation";
export type NarratorMixMode = "avatar" | "broll" | "mixed" | "conversation";
export type NarratorSpeaker = "A" | "B";

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
  // Estilo visual escolhido pra esse segmento (em modo misto). 'avatar' usa a
  // foto original; 'broll' é text-only cinematográfico; 'avatar_cutout' usa
  // foto editada (Nano Banana troca o fundo).
  style?: NarratorSegmentStyle;
  // URL da foto editada por Nano Banana — só pra style='avatar_cutout'.
  editedImageUrl?: string | null;
  // URL do MP3 do TTS específico desse segmento. Setado em modo 'mixed' pros
  // takes 'broll' (avatar/cutout têm áudio Veo nativo). Quando presente, o
  // assembly substitui o áudio do take por esse TTS.
  audioOverlayUrl?: string | null;
  // Modo conversation: qual avatar fala nesse take. "A" = esquerda, "B" = direita.
  speaker?: NarratorSpeaker;
  // ─── Campos do parser de roteiro (mixMode='conversation' v2) ───
  // Tipo do shot. dialog = fala. reaction = ação visual sem fala (1 pessoa).
  // joint_action = ambos agem juntos sem fala.
  shotKind?: "dialog" | "reaction" | "joint_action";
  // Ação visual / expressão facial / gesto (em inglês — entra no prompt Veo).
  // Em dialog: opcional (descreve reação/expressão durante a fala).
  // Em reaction/joint_action: obrigatório (descreve o que mostrar).
  visualAction?: string;
  // Cena ativa (em inglês). Persiste do [Cena ...] mais recente.
  sceneContext?: string;
  // Direção de câmera ativa (em inglês). Persiste do [Corte/câmera ...] mais recente.
  cameraDirection?: string;
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
  // Modo de produção. 'avatar': só avatar falando. 'broll': só cenários sem
  // pessoa. 'mixed': LLM intercala avatar / broll / avatar_cutout.
  // Default 'avatar' quando há foto; 'broll' quando não.
  mixMode?: NarratorMixMode;
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
  // ─── Modo conversation (mixMode='conversation') ───
  // Gênero de cada pessoa da foto. A = pessoa à esquerda, B = à direita.
  // Em outros modos, `gender` continua sendo a fonte da verdade.
  genderA?: "male" | "female";
  genderB?: "male" | "female";
  // Descritores breves de cada pessoa, gerados por GPT-4o-mini Vision na
  // criação do job ("woman with curly dark hair in white shirt"). Usados nos
  // retries (attempt >= 2) pra desambiguar quando o prompt posicional
  // left/right não isolou bem o falante.
  personDescriptorA?: string;
  personDescriptorB?: string;
  // ─── Modo conversation v3 (text-to-video puro) ───
  // Perfil rico de cada pessoa preenchido pelo usuário no form. Usado pra
  // construir o PERSON LOCK em todo prompt Veo, garantindo consistência de
  // identidade entre takes (sem foto base).
  personA?: PersonProfile;
  personB?: PersonProfile;
  // Setting/cenário padrão quando o roteiro não tem [Cena] markers.
  // Default: "neutral indoor setting".
  defaultSetting?: string;
}

export interface PersonProfile {
  gender: "male" | "female";
  // Idade aproximada ("28", "around 30", "early 20s"). Free text.
  age?: string;
  // Descrição física: cabelo, etnia, traços marcantes. Free text PT/EN.
  appearance?: string;
  // Vestuário ("white cropped t-shirt + jeans azul claro"). Free text.
  outfit?: string;
}
