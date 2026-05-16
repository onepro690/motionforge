// LLM parser do roteiro estruturado em ScriptShot[].
//
// Input: texto livre tipo:
//   [Cena 1 — A se aproxima de B na rua]
//   [A] Posso te fazer uma pergunta?
//   [B] (surpresa) Como você sabe?
//   [B fecha o olho. Pausa. A abre uma carta na mão dela.]
//   [Corte direto pra câmera — A falando com quem assiste]
//   [A] Eu não vou te mostrar...
//   parágrafo livre continua A...
//
// Output: lista ordenada de shots ricos pra alimentar buildScriptShotPrompt.

import type { ScriptShot, ScriptShotKind, ScriptSpeaker } from "./script-types";

const SYSTEM_PROMPT = [
  "You are a video script director. The user gives you a short-form video script (TikTok/Reels) with TWO people (A on the LEFT of a photo, B on the RIGHT). Convert it into a strict ordered list of SHOTS for a generative video pipeline (Veo3 image-to-video).",
  "",
  "═══ INPUT SYNTAX THE USER MAY USE ═══",
  "Scene markers (any of these set the active scene context for following shots):",
  "  [Cena N — descrição]  /  [Scene N — description]  /  [Cena descrição]",
  "Camera direction markers (set active camera for following shots until a new one):",
  "  [Corte direto pra câmera — A falando com quem assiste]  /  [Cut to camera ...]  /  [Close-up ...]",
  "Dialog turn (the speaker says the text):",
  "  [A] some text",
  "  [B] some text",
  "Dialog turn with parenthetical reaction (the parenthetical describes the speaker's expression while speaking):",
  "  [A] (surpresa) some text",
  "  [B] (rindo, baixinho) some text",
  "Silent action shot — speaker acts but does NOT speak:",
  "  [B fecha o olho. Pausa. A abre uma carta na mão dela.]",
  "  [A olha pra câmera com um sorriso pequeno.]",
  "Untagged paragraph after a previous [A] or [B] tag: it CONTINUES the same speaker's dialog (append to the previous dialog shot's text). If it comes after a camera direction marker like [Corte direto pra câmera — A falando ...], use the speaker mentioned in that marker.",
  "",
  "═══ OUTPUT — STRICT JSON ═══",
  "{",
  "  \"shots\": [",
  "    {",
  "      \"kind\": \"dialog\" | \"reaction\" | \"joint_action\",",
  "      \"speaker\": \"A\" | \"B\" | null,",
  "      \"spokenText\": \"text in the ORIGINAL language of the script (PT-BR / EN / ES) — exact words to be spoken, NEVER translate, NEVER add narration\",",
  "      \"visualAction\": \"in ENGLISH — describes facial expression / gesture / action visible in the shot\",",
  "      \"sceneContext\": \"in ENGLISH — describes the setting / environment / situation for this shot (carries over from the most recent scene marker)\",",
  "      \"cameraDirection\": \"in ENGLISH — camera framing instruction (carries over from the most recent camera marker)\"",
  "    }",
  "  ]",
  "}",
  "",
  "═══ HOW TO BUILD EACH SHOT ═══",
  "1. DIALOG shot — for every [A] text or [B] text line:",
  "   - kind=\"dialog\", speaker=A or B, spokenText=the original-language text (REMOVE the parenthetical reaction from spokenText), visualAction=English description of the parenthetical reaction if present (else a short neutral description like \"speaks calmly\" or \"speaks with intensity\").",
  "   - IMPORTANT: spokenText must NEVER contain the parenthetical — extract it into visualAction.",
  "   - If the shot is long (>20 words), keep as ONE shot. The downstream pipeline will split it.",
  "2. REACTION shot — for every standalone bracketed action like [B fecha o olho. Pausa. A abre uma carta...]:",
  "   - kind=\"reaction\" (or \"joint_action\" if BOTH people are acting and there's no clear single subject), speaker=the subject (A or B), spokenText=\"\" (EMPTY — they do NOT speak), visualAction=English description of the action.",
  "   - If multiple people are mentioned in the bracket but ONE is the main subject (\"B fecha o olho. A abre uma carta\"), make ONE joint_action shot describing both.",
  "3. CONTINUED dialog — for an untagged paragraph that comes after a [A]/[B] tag or a camera marker that mentions A or B:",
  "   - kind=\"dialog\", speaker = same as previous, append/continue the speech as a NEW dialog shot (don't merge — separate paragraphs become separate shots for camera variety).",
  "4. Scene/camera markers ([Cena ...] / [Corte ...] / [Close-up ...]) DO NOT generate their own shot. They UPDATE sceneContext / cameraDirection that the NEXT shots inherit.",
  "",
  "═══ STRICT RULES ═══",
  "- Output ONLY valid JSON, no markdown, no explanation.",
  "- Translate sceneContext / visualAction / cameraDirection to English. NEVER translate spokenText.",
  "- Every shot must have ALL fields (use empty string \"\" when not applicable, never null EXCEPT speaker).",
  "- Carry sceneContext and cameraDirection forward into following shots until overridden by a new marker.",
  "- If the script has NO scene marker at all, set sceneContext=\"two people sitting/standing side by side in a neutral indoor setting\".",
  "- If no camera marker, set cameraDirection=\"medium two-shot keeping both people fully visible in vertical 9:16 frame\".",
  "- Preserve order strictly — shots reflect the chronological order of the script.",
  "- Reject inventing shots or content that is not in the input.",
].join("\n");

export async function parseScript(rawScript: string): Promise<ScriptShot[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: rawScript },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI script parse error: ${res.status} ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { shots?: Array<Partial<ScriptShot>> };
  const shots = parsed.shots ?? [];

  // Normaliza e valida cada shot. Drop shots inválidos (sem speaker quando precisa, etc).
  const normalized: ScriptShot[] = [];
  for (const raw of shots) {
    const kind = (raw.kind ?? "dialog") as ScriptShotKind;
    const speakerRaw = raw.speaker;
    const speaker = (speakerRaw === "A" || speakerRaw === "B") ? speakerRaw as ScriptSpeaker : null;
    const spokenText = (raw.spokenText ?? "").trim();
    const visualAction = (raw.visualAction ?? "").trim();
    const sceneContext = (raw.sceneContext ?? "two people sitting side by side in a neutral indoor setting").trim();
    const cameraDirection = (raw.cameraDirection ?? "medium two-shot keeping both people fully visible in vertical 9:16 frame").trim();

    // Validação por tipo
    if (kind === "dialog") {
      if (!speaker || !spokenText) continue; // dialog sem speaker ou sem texto é inválido
    } else if (kind === "reaction") {
      if (!speaker || !visualAction) continue;
    } else if (kind === "joint_action") {
      if (!visualAction) continue;
    } else {
      continue;
    }

    normalized.push({
      kind,
      speaker,
      spokenText,
      visualAction: visualAction || (kind === "dialog" ? "speaks calmly to the other person" : "stays still"),
      sceneContext,
      cameraDirection,
    });
  }

  return normalized;
}

// Conta speakers únicos pra validação (precisa ter A e B presentes em algum shot).
export function speakerCounts(shots: ScriptShot[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const s of shots) {
    if (s.speaker === "A") a++;
    else if (s.speaker === "B") b++;
  }
  return { a, b };
}
