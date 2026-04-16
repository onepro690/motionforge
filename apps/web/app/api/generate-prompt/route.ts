import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const schema = z.object({
  description: z.string().min(5).max(1000).optional(),
  descriptions: z.array(z.string().min(1).max(1000)).optional(),
  speechTexts: z.array(z.string().max(500)).optional(), // parallel to descriptions — user-provided speech per take
  existingPrompts: z.array(z.string()).optional(),       // parallel to descriptions — existing JSON prompts to adjust instead of generate from scratch
}).refine((d) => d.description || (d.descriptions && d.descriptions.length > 0), {
  message: "Provide either description or descriptions",
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.errors },
        { status: 400 }
      );
    }

    const { description, descriptions, speechTexts, existingPrompts } = parsed.data;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY não configurada nas variáveis de ambiente." },
        { status: 500 }
      );
    }

    const openai = createOpenAI({ apiKey });

    const QUALITY = "single person only, exactly two arms and two legs, no extra limbs, smooth and natural motion without jitter, consistent identity throughout, physically plausible joint angles, clean body edges without morphing artifacts, when speaking: perfect lip sync with every syllable — lips and jaw move in precise sync with each word, natural mouth open and close articulation, no mouth glitching, no flickering lips, no lip twitching, no stutter artifacts, realistic dental visibility";

    const FIELDS = `{
    "speech": "ONLY populate if the user EXPLICITLY asks the avatar to say specific words — indicated by: direct quotes (e.g. \"olá\"), or verbs like fala/fale/diz/dizer/say/speak/talk followed by the words. Generic motion descriptions, actions, or expressions are NOT speech — leave as empty string. When in doubt, leave empty.",
    "speech_language": "Language and accent for the speech. If the user specifies one (e.g. 'in English', 'em espanhol'), use that exactly. Otherwise infer from the language of the user's description: if Portuguese → 'Brazilian Portuguese'; if English → 'American English'; if Spanish → 'Latin American Spanish'. Leave empty string when speech field is empty.",
    "motion_type": "specific movement or dance style",
    "body_focus": ["list", "of", "body", "parts"],
    "intensity": "low | medium | high",
    "rhythm": "description of tempo and timing",
    "facial_expression": "emotion and gaze direction",
    "style": "overall style descriptor",
    "motion_detail": "2-3 sentences describing exact movement. Include ALL specific details the user mentioned about how to move, gestures, expressions, or anything else not captured in other fields.",
    "quality": "${QUALITY}"
  }`;

    // ── Adjust mode: modify existing prompt JSON with user feedback ──
    // Used by video regen: keeps all original params, only changes what feedback asks
    if (descriptions && descriptions.length > 0 && existingPrompts && existingPrompts.length > 0) {
      const adjusted = await Promise.all(
        descriptions.map(async (feedback, i) => {
          const existing = existingPrompts[i] ?? "";
          const userSpeech = speechTexts?.[i] ?? "";

          const { text } = await generateText({
            model: openai("gpt-4o-mini"),
            system: `You are adjusting an existing animation JSON prompt for a video AI model.
You will receive the current JSON prompt and user feedback describing what to change.
Apply ONLY the changes requested by the feedback to the relevant fields (motion_detail, motion_type, style, rhythm, facial_expression, intensity, body_focus).
NEVER change: speech, speech_language, quality — keep those fields identical to the original.
Return the complete modified JSON object. No extra text, no markdown, no code blocks.`,
            prompt: `Existing prompt:\n${existing}\n\nFeedback (apply only this change): "${feedback}"`,
          });

          let obj: Record<string, unknown>;
          try {
            const raw = text.trim();
            const match = raw.match(/\{[\s\S]*\}/);
            obj = JSON.parse(match ? match[0] : raw) as Record<string, unknown>;
          } catch {
            // If parse fails, return the original
            obj = JSON.parse(existing) as Record<string, unknown>;
          }

          // Always enforce the user's speech (never let GPT alter it)
          obj.speech = userSpeech.trim();
          if (!obj.speech) obj.speech_language = "";

          return JSON.stringify(obj, null, 2);
        })
      );

      return NextResponse.json({ prompts: adjusted });
    }

    // ── Batch mode: multiple descriptions → looping prompt sequence ──
    if (descriptions && descriptions.length > 0) {
      const isLoop = descriptions.length > 1;
      const count = descriptions.length;

      const loopInstructions = isLoop
        ? `IMPORTANT — SEAMLESS LOOP DESIGN:
The clips will be merged in order (1 → 2 → ... → ${count} → back to 1).
Each clip must END in a motion state that flows naturally into the NEXT clip's START.
The last clip must end in a position that flows back into the first clip — creating a seamless loop.
Design the motion_detail of each clip with an explicit end-pose that connects to the next clip's beginning.`
        : "";

      const systemPrompt = `You are an expert in video animation prompts for AI models like SeedDance.
You will receive ${count} animation description(s) and must return exactly ${count} JSON prompt object(s).

${loopInstructions}

Return ONLY a valid JSON array with exactly ${count} object(s), each with these fields:
[
  ${FIELDS}
]

CRITICAL RULES:
- Use the same language as the user's description throughout all fields
- IMPORTANT: If the user writes in Portuguese, ALWAYS use Brazilian Portuguese (pt-BR) — NEVER European Portuguese. Use "você", "a gente", Brazilian vocabulary and expressions.
- The "speech" field: ONLY fill when the user EXPLICITLY asks for specific words to be spoken (quotes, fala/diz/say + words). If there is no explicit speech request, set speech to empty string ""
- The "speech_language" field: copy exactly what the user says (e.g. "em português do Brasil" → "Brazilian Portuguese")
- The "motion_detail" field: incorporate ALL specific details from the user's description that aren't covered elsewhere
- Return a JSON array, not an object
- No extra text, no markdown, no code blocks
- Do NOT mention background, clothing, or scene`;

      const { text } = await generateText({
        model: openai("gpt-4o-mini"),
        system: systemPrompt,
        prompt: descriptions.map((d, i) => `Take ${i + 1}: "${d}"`).join("\n"),
      });

      let arr: unknown[];
      try {
        const raw = text.trim();
        const match = raw.match(/\[[\s\S]*\]/);
        arr = JSON.parse(match ? match[0] : raw) as unknown[];
      } catch {
        throw new Error("Modelo retornou formato inválido");
      }

      if (!Array.isArray(arr) || arr.length !== descriptions.length) {
        throw new Error("Número de prompts retornados não corresponde ao número de takes");
      }

      // Override speech field with what the user explicitly typed — never let GPT guess
      const finalArr = arr.map((p, i) => {
        const obj = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
        const userSpeech = speechTexts?.[i] ?? "";
        obj.speech = userSpeech.trim();
        // If no speech, explicitly clear language too
        if (!obj.speech) obj.speech_language = "";
        return obj;
      });

      return NextResponse.json({ prompts: finalArr.map((p) => JSON.stringify(p, null, 2)) });
    }

    // ── Single mode (backwards compat) ──
    const systemPromptSingle = `You are an expert in video animation prompts for AI models like SeedDance.
Transform a user description into a structured JSON animation prompt for animating a human avatar.

Return ONLY a valid JSON object with exactly these fields (no extra text, no markdown, no code blocks):

${FIELDS}

CRITICAL RULES:
- Use the same language as the user's description throughout all fields
- IMPORTANT: If the user writes in Portuguese, ALWAYS use Brazilian Portuguese (pt-BR) — NEVER European Portuguese. Use "você", "a gente", Brazilian vocabulary and expressions.
- The "speech" field: ONLY fill when the user EXPLICITLY asks for specific words to be spoken (quotes, fala/diz/say + words). If there is no explicit speech request, set speech to empty string ""
- The "speech_language" field: copy exactly what the user says (e.g. "em português do Brasil" → "Brazilian Portuguese")
- The "motion_detail" field: incorporate ALL specific details from the user's description that aren't covered elsewhere
- Do NOT mention background, clothing, or scene
- The "quality" field must always be exactly as shown above, verbatim`;

    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      system: systemPromptSingle,
      prompt: `User description: "${description}"\n\nGenerate the JSON animation prompt:`,
    });

    let jsonData: unknown;
    try {
      jsonData = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Modelo retornou formato inválido");
      jsonData = JSON.parse(match[0]);
    }

    return NextResponse.json({ prompt: JSON.stringify(jsonData, null, 2) });
  } catch (error) {
    console.error("Generate prompt error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao gerar prompt" },
      { status: 500 }
    );
  }
}
