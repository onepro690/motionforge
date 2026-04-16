import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";

const GOOGLE_AI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ANALYSIS_MODEL = "gemini-2.5-flash";

const schema = z.object({
  imageUrl: z.string().url(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "GOOGLE_AI_API_KEY not configured" }, { status: 500 });

    const imgRes = await fetch(parsed.data.imageUrl);
    if (!imgRes.ok) return NextResponse.json({ error: "Falha ao baixar imagem" }, { status: 502 });
    const imgBase64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
    const imgMime = imgRes.headers.get("content-type") ?? "image/jpeg";

    const systemPrompt = `You are an expert image analyst. Analyze the provided image and return a JSON object describing it in detail so that a text-to-image AI can recreate a similar image.

Return ONLY valid JSON, no markdown, no code blocks:
{
  "generationPrompt": "A single comprehensive prompt (2-4 sentences) describing the full image with enough detail to recreate it. Include subject, appearance, clothing, pose, expression, background, lighting, style.",
  "aspects": {
    "person": "Who is in the image (age range, gender, ethnicity if visible, physical build)",
    "hair": "Hair color, length, style, texture",
    "clothing": "Clothing items, colors, style",
    "background": "Environment, setting, background details",
    "lighting": "Lighting type, direction, mood",
    "pose": "Body position, posture, gesture",
    "expression": "Facial expression, mood, eye direction",
    "style": "Photo style: realistic photo / illustration / painting / etc."
  }
}`;

    const res = await fetch(
      `${GOOGLE_AI_BASE}/models/${ANALYSIS_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType: imgMime, data: imgBase64 } },
                { text: systemPrompt },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message: string };
    };

    if (!res.ok || data.error) {
      return NextResponse.json(
        { error: data.error?.message ?? "Falha ao analisar imagem" },
        { status: 502 }
      );
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let analysis: unknown;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(match ? match[0] : text);
    } catch {
      return NextResponse.json({ error: "Modelo retornou formato inválido" }, { status: 502 });
    }

    return NextResponse.json(analysis);
  } catch (error) {
    console.error("[analyze-image] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
