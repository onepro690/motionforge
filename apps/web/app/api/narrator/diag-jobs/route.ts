// Endpoint admin pra inspecionar jobs do narrator e reproduzir testes.
// Acesso via ?secret=motionforge2026. Sem auth de session.
//
// GET ?secret=...                  → lista últimos 10 jobs narrator
// GET ?secret=...&jobId=ID         → state completo do job
// GET ?secret=...&action=last      → último job (atalho)
// POST { secret, jobId }           → clona job antigo (mesma copy + avatarImageUrl) e cria um novo

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@motion/database";
import type { NarratorJobState } from "@/lib/narrator/types";
import { computeTakeCount, planAvatarSegments, planNarratorSegments } from "@/lib/narrator/plan";
import {
  submitVeoTextOnly,
  submitVeoWithImage,
  fetchImageForVeo,
  getVertexAccessToken,
  type VeoImageInput,
} from "@/lib/narrator/veo";
import { detectLanguage } from "@/lib/narrator/language";
import { buildAvatarSpeechPrompt, buildAvatarSilentPrompt, buildBrollPrompt } from "@/lib/narrator/prompts";
import { assembleNarratorVideo } from "@/lib/narrator/assemble";
import type { NarratorSegmentState } from "@/lib/narrator/types";

const SECRET = "motionforge2026";

function unauth() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  if (sp.get("secret") !== SECRET) return unauth();

  const jobId = sp.get("jobId");
  const action = sp.get("action");

  // Força execução do assembly final pra um job que tem todos os takes
  // COMPLETED mas o assembly travou. Retorna erro detalhado (incluindo stderr
  // do ffmpeg) no response pra debug sem precisar de logs Vercel.
  if (action === "force-assemble" && jobId) {
    const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!job.generatedPrompt) return NextResponse.json({ error: "no state" }, { status: 400 });
    const state: NarratorJobState = JSON.parse(job.generatedPrompt);

    const takeUrls = state.segments.map((s) => s.videoUrl).filter((u): u is string => Boolean(u));
    if (takeUrls.length === 0) return NextResponse.json({ error: "no take videos" }, { status: 400 });

    // Limpa lock pra permitir retry
    state.assemblyStartedAt = null;
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { generatedPrompt: JSON.stringify(state) },
    });

    const t0 = Date.now();
    try {
      const result = await assembleNarratorVideo({
        takeUrls,
        narrationAudioUrl: state.narrationAudioUrl,
        narrationSeconds: state.narrationDurationSeconds,
        jobId: job.id,
        audioMode: state.audioMode,
      });
      state.finalVideoUrl = result.finalVideoUrl;
      await prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          outputVideoUrl: result.finalVideoUrl,
          completedAt: new Date(),
          generatedPrompt: JSON.stringify(state),
        },
      });
      return NextResponse.json({
        ok: true,
        elapsedMs: Date.now() - t0,
        finalVideoUrl: result.finalVideoUrl,
        durationSeconds: result.durationSeconds,
      });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string; code?: number; signal?: string };
      return NextResponse.json({
        ok: false,
        elapsedMs: Date.now() - t0,
        message: e.message,
        code: e.code,
        signal: e.signal,
        stderrTail: e.stderr?.slice(-4000),
        stdoutTail: e.stdout?.slice(-1500),
        takeUrls,
      }, { status: 500 });
    }
  }

  if (jobId) {
    const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    let state: NarratorJobState | null = null;
    try {
      state = job.generatedPrompt ? JSON.parse(job.generatedPrompt) : null;
    } catch (e) {
      // ignore
    }
    return NextResponse.json({
      id: job.id,
      status: job.status,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      outputVideoUrl: job.outputVideoUrl,
      inputImageUrl: job.inputImageUrl,
      state,
    });
  }

  // List recent
  const jobs = await prisma.generationJob.findMany({
    where: { provider: "narrator" },
    orderBy: { createdAt: "desc" },
    take: action === "last" ? 1 : 10,
    select: {
      id: true,
      userId: true,
      status: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
      outputVideoUrl: true,
      inputImageUrl: true,
      promptText: true,
      generatedPrompt: true,
      createdAt: true,
    },
  });
  // Resume each
  const out = jobs.map((j) => {
    let state: Partial<NarratorJobState> | null = null;
    try {
      state = j.generatedPrompt ? JSON.parse(j.generatedPrompt) : null;
    } catch {
      state = null;
    }
    return {
      id: j.id,
      userId: j.userId,
      status: j.status,
      errorMessage: j.errorMessage,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      hasOutput: Boolean(j.outputVideoUrl),
      avatarImageUrl: j.inputImageUrl,
      copyPreview: j.promptText?.slice(0, 140),
      segmentCount: state?.segments?.length ?? 0,
      segmentStatuses: state?.segments?.map((s) => `${s.index}:${s.status}${s.retryCount ? `(r${s.retryCount})` : ""}${s.usedFallback ? "[F]" : ""}`),
      assemblyAttempts: state?.assemblyAttempts ?? 0,
      assemblyStartedAt: state?.assemblyStartedAt,
      finalErrorMessage: state?.finalErrorMessage,
      audioMode: state?.audioMode,
      language: state?.language,
      createdAt: j.createdAt,
    };
  });
  return NextResponse.json({ jobs: out });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { secret?: string; jobId?: string };
  if (body.secret !== SECRET) return unauth();
  if (!body.jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  // Clone an existing job: same userId, copy and avatar.
  const old = await prisma.generationJob.findUnique({ where: { id: body.jobId } });
  if (!old) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (old.provider !== "narrator") return NextResponse.json({ error: "not a narrator job" }, { status: 400 });

  const copy = old.promptText ?? "";
  const avatarImageUrl = old.inputImageUrl || null;
  // Pega gender do state antigo se existir.
  let oldState: NarratorJobState | null = null;
  try { oldState = old.generatedPrompt ? JSON.parse(old.generatedPrompt) : null; } catch {}
  const gender = oldState?.gender ?? "male";
  const audioMode = oldState?.audioMode ?? (avatarImageUrl ? "veo_native" : "tts_overlay");

  // Cria novo job
  const newJob = await prisma.generationJob.create({
    data: {
      userId: old.userId,
      status: "PROCESSING",
      provider: "narrator",
      inputImageUrl: avatarImageUrl ?? "",
      promptText: copy,
      aspectRatio: "RATIO_9_16",
      maxDuration: 8,
      startedAt: new Date(),
    },
  });

  try {
    const language = detectLanguage(copy);
    // Pra simplificar, estima duração via word count em vez de chamar TTS aqui.
    const narrationDuration = Math.max(2, copy.split(/\s+/).filter(Boolean).length / 2.8);
    const takeCount = computeTakeCount(narrationDuration);
    const segments = avatarImageUrl
      ? planAvatarSegments(copy, takeCount)
      : await planNarratorSegments({ copy, takeCount });

    const accessToken = await getVertexAccessToken();
    let avatarImage: VeoImageInput | null = null;
    if (avatarImageUrl) {
      avatarImage = await fetchImageForVeo(avatarImageUrl);
    }

    const submittedAt = Date.now();
    const submitResults = await Promise.allSettled(
      segments.map((seg) => {
        if (avatarImage) {
          const prompt = audioMode === "veo_native"
            ? buildAvatarSpeechPrompt(seg.text, gender, undefined, 0, language)
            : buildAvatarSilentPrompt(undefined, 0);
          return submitVeoWithImage(prompt, avatarImage, accessToken);
        }
        return submitVeoTextOnly(buildBrollPrompt(seg.visualPrompt, undefined, 0), accessToken);
      }),
    );

    const segState: NarratorSegmentState[] = segments.map((seg, i) => {
      const r = submitResults[i];
      if (r.status === "fulfilled") {
        return {
          index: i, text: seg.text, visualPrompt: seg.visualPrompt,
          opName: r.value.opName, status: "PROCESSING", videoUrl: null,
          errorMessage: null, lastSubmittedAt: submittedAt,
        };
      }
      return {
        index: i, text: seg.text, visualPrompt: seg.visualPrompt,
        opName: null, status: "FAILED", videoUrl: null,
        errorMessage: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    const state: NarratorJobState = {
      kind: "narrator-v1",
      copy,
      voice: gender === "male" ? "onyx" : "nova",
      gender,
      avatarImageUrl: avatarImageUrl ?? null,
      audioMode,
      language,
      narrationAudioUrl: null,
      narrationDurationSeconds: narrationDuration,
      segments: segState,
      finalVideoUrl: null,
      finalErrorMessage: null,
    };

    await prisma.generationJob.update({
      where: { id: newJob.id },
      data: { generatedPrompt: JSON.stringify(state), maxDuration: Math.ceil(narrationDuration) },
    });

    return NextResponse.json({
      newJobId: newJob.id,
      takeCount,
      segments: segState.map((s) => ({ index: s.index, status: s.status, opName: s.opName, error: s.errorMessage })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro";
    await prisma.generationJob.update({
      where: { id: newJob.id },
      data: { status: "FAILED", errorMessage: msg, completedAt: new Date() },
    });
    return NextResponse.json({ newJobId: newJob.id, error: msg }, { status: 500 });
  }
}
