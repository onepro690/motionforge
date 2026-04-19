// Trigger generation for one or more approved products
// Can be called manually by user or by the scheduler

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { runVideoPipeline } from "@/lib/ugc/pipeline";
import { z } from "zod";

// Precisa caber: LLM (analyze, brief, copy, veo prompts) + TTS + image fetch
// + getAccessToken + submitVeoTake ×3. ~60-120s típico. Bump pra 300 (limite).
export const maxDuration = 300;
export const runtime = "nodejs";

const schema = z.object({
  productIds: z.array(z.string()).optional(), // specific products to use
  count: z.number().int().min(1).max(10).default(1),
  characterId: z.string().optional(), // personagem a usar como avatar
  noAvatar: z.boolean().optional(), // sem avatar — só troca fenótipo via prompt
  transitionMode: z.enum(["continuous", "hard_cuts", "fidelity_clone"]).optional(), // fidelity_clone bypassa Veo e faz face-swap frame-a-frame
  narrationOverride: z.enum(["auto", "speech", "silent"]).optional(), // força fala/silent/auto
});

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = session.user.id;

    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.message }, { status: 400 });
    }

    const { productIds, count, characterId, noAvatar, transitionMode, narrationOverride } = parsed.data;

    // Fidelity clone exige personagem com foto — face swap precisa de imagem fonte.
    if (transitionMode === "fidelity_clone" && noAvatar) {
      return NextResponse.json({
        error: "Clone fiel requer um personagem com foto. Desative 'Sem avatar' ou escolha outro modo.",
      }, { status: 400 });
    }

    // Valida personagem se fornecido (pulado quando noAvatar=true)
    if (!noAvatar) {
      if (characterId) {
        const character = await prisma.ugcCharacter.findUnique({ where: { id: characterId } });
        if (!character || character.userId !== userId) {
          return NextResponse.json({ error: "Personagem não encontrado" }, { status: 400 });
        }
      } else {
        // Verifica se tem pelo menos um personagem
        const anyChar = await prisma.ugcCharacter.findFirst({ where: { userId } });
        if (!anyChar) {
          return NextResponse.json({
            error: "Nenhum personagem criado. Vá em Personagens e crie um avatar primeiro.",
          }, { status: 400 });
        }
      }
    }

    const settings = await prisma.ugcSystemSettings.findUnique({ where: { userId } });
    const toGenerate = count;

    // Get approved products (includes USED_FOR_GENERATION for re-generation)
    let approvedProducts = await prisma.ugcTrendingProduct.findMany({
      where: {
        userId,
        status: { in: ["APPROVED", "USED_FOR_GENERATION"] },
        ...(productIds?.length ? { id: { in: productIds } } : {}),
      },
      orderBy: { score: "desc" },
      take: toGenerate,
    });

    if (approvedProducts.length === 0) {
      if (settings?.autoMode) {
        approvedProducts = await prisma.ugcTrendingProduct.findMany({
          where: { userId, status: "DETECTED" },
          orderBy: { score: "desc" },
          take: toGenerate,
        });
      }
      if (approvedProducts.length === 0) {
        return NextResponse.json({
          error: "Nenhum produto aprovado encontrado. Aprove produtos em alta primeiro.",
          debug: { userId, productIds },
        }, { status: 400 });
      }
    }

    const createdVideos: string[] = [];

    // noAvatar=true → sem personagem; caso contrário, usa o fornecido ou o primeiro do usuário
    const finalCharacterId = noAvatar
      ? null
      : characterId ?? (await prisma.ugcCharacter.findFirst({ where: { userId } }))?.id ?? null;

    for (let i = 0; i < Math.min(toGenerate, approvedProducts.length); i++) {
      const product = approvedProducts[i % approvedProducts.length];

      const video = await prisma.ugcGeneratedVideo.create({
        data: {
          userId,
          productId: product.id,
          characterId: finalCharacterId,
          status: "DRAFT_GENERATED",
          title: `${product.name} - v${Date.now()}`,
          currentStep: "queued",
          transitionMode: transitionMode ?? "continuous",
          narrationOverride: narrationOverride ?? "auto",
        },
      });

      createdVideos.push(video.id);
    }

    // Roda todas as pipelines SEQUENCIALMENTE em um único after()
    // Evita rate limit do Veo3 e conflitos de recursos
    after(async () => {
      for (const videoId of createdVideos) {
        try {
          console.log(`[ugc/generate] Starting pipeline for video ${videoId}...`);
          await runVideoPipeline(videoId);
          console.log(`[ugc/generate] Pipeline completed for video ${videoId}`);
        } catch (err) {
          console.error(`[ugc/generate] Pipeline failed for video ${videoId}:`, err);
          await prisma.ugcGeneratedVideo.update({
            where: { id: videoId },
            data: {
              status: "FAILED",
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          }).catch(() => null);
        }
      }
    });

    return NextResponse.json({
      success: true,
      videosCreated: createdVideos.length,
      videoIds: createdVideos,
    });
  } catch (err) {
    console.error("[ugc/generate] Unhandled error:", err);
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Erro interno ao gerar vídeo",
    }, { status: 500 });
  }
}
