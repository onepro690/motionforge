// Tipos do modo "Roteiro com 2 personagens" (mixMode='conversation').
// Um shot = 1 take Veo gerado da MESMA foto base. Pode ser falado (dialog),
// silencioso com ação visual (reaction) ou ambos agindo juntos (joint_action).

export type ScriptSpeaker = "A" | "B";

export type ScriptShotKind =
  | "dialog" // Alguém fala. Tem speaker e spokenText. Pode ter visualAction (ex: reação no parêntese).
  | "reaction" // Alguém age/reage sem falar. Tem speaker e visualAction. spokenText vazio.
  | "joint_action"; // Ambos agem juntos sem falar. speaker null. visualAction descreve a ação combinada.

export interface ScriptShot {
  kind: ScriptShotKind;
  // Speaker é null em joint_action.
  speaker: ScriptSpeaker | null;
  // Texto exato a ser falado no idioma original da copy. Vazio em reaction/joint_action.
  spokenText: string;
  // Ação visual / expressão / gesto (em inglês — entra direto no prompt Veo).
  // Em dialog: opcional (descreve gesto/expressão durante a fala). Em reaction/joint: obrigatório.
  visualAction: string;
  // Cena ativa (em inglês). Vem do [Cena N — descrição] mais recente.
  // Persiste até nova marcação de cena. Default: "" (sem cena setup).
  sceneContext: string;
  // Direção de câmera ativa (em inglês). Vem do [Corte / Câmera ...] mais recente.
  // Default: framing wide com ambos no quadro.
  cameraDirection: string;
}
