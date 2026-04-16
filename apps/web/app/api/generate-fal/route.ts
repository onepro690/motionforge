import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { z } from "zod";

const FAL_BASE = "https://fal.run";

const NSFW_LORA = {
  path: "https://huggingface.co/enhanceaiteam/Flux-uncensored/resolve/main/lora.safetensors",
  scale: 1.0,
};

const ASPECT_TO_SIZE: Record<string, string> = {
  "9:16":  "portrait_16_9",
  "16:9":  "landscape_16_9",
  "1:1":   "square_hd",
  "3:4":   "portrait_4_3",
  "4:3":   "landscape_4_3",
};

const schema = z.object({
  mode: z.enum(["text", "copy", "outfit"]).default("text"),
  prompt:            z.string().max(3000).default(""),
  imageSize:         z.enum(["square_hd","square","portrait_4_3","portrait_16_9","landscape_4_3","landscape_16_9"]).default("portrait_16_9"),
  numImages:         z.number().int().min(1).max(4).default(1),
  negativePrompt:    z.string().max(1000).optional(),
  referenceImageUrl: z.string().url().optional(),
  modifications:     z.string().max(2000).optional(),
  faceImageUrl:      z.string().url().optional(),
  outfitImageUrl:    z.string().url().optional(),
  aspectRatio:       z.enum(["1:1","9:16","16:9","3:4","4:3"]).default("9:16"),
});


export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json({ error: "Invalid input", details: parsed.error.errors }, { status: 400 });

    const apiKey = process.env.FAL_KEY;
    if (!apiKey) return NextResponse.json({ error: "FAL_KEY not configured" }, { status: 500 });

    const d = parsed.data;

    // ── MODE: outfit — cat-vton (virtual try-on, image-based) ────────────────
    if (d.mode === "outfit") {
      if (!d.referenceImageUrl || !d.outfitImageUrl)
        return NextResponse.json({ error: "Foto do avatar e da roupa são obrigatórias" }, { status: 400 });

      const res = await fetch(`${FAL_BASE}/fal-ai/cat-vton`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          human_image_url:   d.referenceImageUrl,
          garment_image_url: d.outfitImageUrl,
          cloth_type:        "overall",
          num_inference_steps: 30,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error("[generate-fal/outfit] error:", err);
        return NextResponse.json({ error: `fal.ai error: ${err}` }, { status: 502 });
      }
      const data = await res.json();
      const url = data.image?.url;
      if (!url) return NextResponse.json({ error: "Modelo não retornou imagem" }, { status: 502 });
      return NextResponse.json({ images: [{ url, width: data.image?.width ?? 0, height: data.image?.height ?? 0 }], seed: null });
    }

    // ── MODE: copy with phenotype — hy-wu-edit (image-based face/phenotype swap) ──
    if (d.mode === "copy" && d.faceImageUrl) {
      if (!d.referenceImageUrl)
        return NextResponse.json({ error: "Foto de referência obrigatória" }, { status: 400 });

      const extras = d.modifications?.trim() ? ` ${d.modifications.trim()}.` : "";
      const prompt = `Swap the face and complete physical appearance (skin tone, hair color, hair length, hair style, eye color, eyebrows, ethnicity, facial features) of the person in the first image to exactly match the person in the second image.${extras} Keep the clothing, outfit, accessories, body pose, background, environment, lighting, and camera angle from the first image completely unchanged.`;

      const res = await fetch(`${FAL_BASE}/fal-ai/hy-wu-edit`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          image_urls:            [d.referenceImageUrl, d.faceImageUrl],
          image_size:            ASPECT_TO_SIZE[d.aspectRatio] ?? "portrait_16_9",
          num_inference_steps:   30,
          enable_safety_checker: false,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error("[generate-fal/phenotype] error:", err);
        return NextResponse.json({ error: `fal.ai error: ${err}` }, { status: 502 });
      }
      const data = await res.json();
      return NextResponse.json({ images: data.images, seed: data.seed });
    }

    // ── MODE: copy (img2img, no face swap) ───────────────────────────────────
    if (d.mode === "copy") {
      if (!d.referenceImageUrl)
        return NextResponse.json({ error: "Foto de referência obrigatória" }, { status: 400 });

      const prompt = d.modifications?.trim()
        ? d.modifications.trim()
        : "reproduce this image exactly, same person, same pose, same clothing, same background";

      const res = await fetch(`${FAL_BASE}/fal-ai/flux/dev/image-to-image`, {
        method: "POST",
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url:             d.referenceImageUrl,
          prompt,
          strength:              0.75,
          num_inference_steps:   28,
          enable_safety_checker: false,
          loras:                 [NSFW_LORA],
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ error: `fal.ai error: ${err}` }, { status: 502 });
      }
      const data = await res.json();
      return NextResponse.json({ images: data.images, seed: data.seed });
    }

    // ── MODE: text (text-to-image) ───────────────────────────────────────────
    const imageSize = d.imageSize ?? ASPECT_TO_SIZE[d.aspectRatio] ?? "portrait_16_9";

    const payload: Record<string, unknown> = {
      prompt:                d.prompt,
      image_size:            imageSize,
      num_images:            d.numImages,
      num_inference_steps:   28,
      enable_safety_checker: false,
      loras:                 [NSFW_LORA],
    };
    if (d.negativePrompt) payload.negative_prompt = d.negativePrompt;

    const res = await fetch(`${FAL_BASE}/fal-ai/flux/dev`, {
      method: "POST",
      headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `fal.ai error: ${err}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json({ images: data.images, seed: data.seed });

  } catch (error) {
    console.error("[generate-fal] POST error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erro interno" }, { status: 500 });
  }
}
