import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { put } from "@vercel/blob";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { pollVeoOperation, downloadVeoVideo, getVertexAccessToken } from "@/lib/narrator/veo";
import { assembleNarratorVideo } from "@/lib/narrator/assemble";
import type { NarratorJobState } from "@/lib/narrator/types";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const maxDuration = 300;

// Remove a faixa de áudio do MP4 (Veo gera com áudio random; vamos sobrepor TTS)
async function stripAudio(input: Buffer): Promise<Buffer> {
  const id = randomBytes(8).toString("hex");
  const inPath  = join("/tmp", `veo-strip-in-${id}.mp4`);
  const outPath = join("/tmp", `veo-strip-out-${id}.mp4`);
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .outputOptions(["-an", "-c:v", "copy", "-movflags", "+faststart"])
        .output(outPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const job = await prisma.generationJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (job.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (job.provider !== "narrator") {
      return NextResponse.json({ error: "Job não é narrator" }, { status: 400 });
    }

    if (!job.generatedPrompt) {
      return NextResponse.json({ error: "Job sem estado" }, { status: 500 });
    }
    const state: NarratorJobState = JSON.parse(job.generatedPrompt);

    // Curto-circuito: já completou
    if (job.status === "COMPLETED" && state.finalVideoUrl) {
      return NextResponse.json({
        id: job.id,
        status: "COMPLETED",
        finalVideoUrl: state.finalVideoUrl,
        narrationDurationSeconds: state.narrationDurationSeconds,
        segments: state.segments.map((s) => ({ index: s.index, status: s.status, text: s.text })),
      });
    }
    if (job.status === "FAILED") {
      return NextResponse.json({
        id: job.id,
        status: "FAILED",
        errorMessage: job.errorMessage ?? state.finalErrorMessage,
        segments: state.segments.map((s) => ({ index: s.index, status: s.status, text: s.text, error: s.errorMessage })),
      });
    }

    // Polling: pra cada segmento PROCESSING, chama fetchPredictOperation
    const accessToken = await getVertexAccessToken();
    const pendingIdx = state.segments.map((s, i) => (s.status === "PROCESSING" && s.opName ? i : -1)).filter((i) => i >= 0);

    if (pendingIdx.length > 0) {
      const polls = await Promise.all(
        pendingIdx.map((i) => pollVeoOperation(state.segments[i].opName!, accessToken).then((r) => ({ idx: i, r })))
      );

      // Quando o áudio do Veo É a narração final (avatar falando lip-sync), NÃO
      // stripa — precisamos preservar pra usar no assembly. Caso contrário (B-roll
      // ou avatar mudo com TTS overlay), removemos pra trocar pela TTS depois.
      const preserveVeoAudio = state.audioMode === "veo_native";

      for (const { idx, r } of polls) {
        if (!r.done) continue;
        const seg = state.segments[idx];
        if (r.errorMessage) {
          seg.status = "FAILED";
          seg.errorMessage = r.errorMessage;
          continue;
        }
        try {
          const rawBuffer = await downloadVeoVideo({ uri: r.videoUri, base64: r.videoBase64 }, accessToken);
          const finalBuffer = preserveVeoAudio ? rawBuffer : await stripAudio(rawBuffer);
          const blob = await put(`narrator-${job.id}-take-${idx}.mp4`, finalBuffer, {
            access: "public",
            contentType: "video/mp4",
            addRandomSuffix: false,
            allowOverwrite: true,
          });
          seg.status = "COMPLETED";
          seg.videoUrl = blob.url;
        } catch (err) {
          seg.status = "FAILED";
          seg.errorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      // Persiste progresso parcial (mesmo se ainda há pendentes)
      await prisma.generationJob.update({
        where: { id: job.id },
        data: { generatedPrompt: JSON.stringify(state) },
      });
    }

    // Verifica status global
    const allDone = state.segments.every((s) => s.status === "COMPLETED" || s.status === "FAILED");
    const anyFailed = state.segments.some((s) => s.status === "FAILED");
    const allOk = state.segments.every((s) => s.status === "COMPLETED");

    if (!allDone) {
      return NextResponse.json({
        id: job.id,
        status: "PROCESSING",
        narrationDurationSeconds: state.narrationDurationSeconds,
        segments: state.segments.map((s) => ({ index: s.index, status: s.status, text: s.text })),
        progress: {
          completed: state.segments.filter((s) => s.status === "COMPLETED").length,
          total: state.segments.length,
        },
      });
    }

    // Todos finalizados → assembly OU falha
    if (anyFailed) {
      const errs = state.segments.filter((s) => s.status === "FAILED").map((s) => `take ${s.index + 1}: ${s.errorMessage ?? "erro"}`).join(" | ");
      const msg = `Falha em ${state.segments.filter((s) => s.status === "FAILED").length} de ${state.segments.length} takes: ${errs}`;
      state.finalErrorMessage = msg;
      await prisma.generationJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errorMessage: msg,
          completedAt: new Date(),
          generatedPrompt: JSON.stringify(state),
        },
      });
      return NextResponse.json({
        id: job.id,
        status: "FAILED",
        errorMessage: msg,
        segments: state.segments.map((s) => ({ index: s.index, status: s.status, text: s.text, error: s.errorMessage })),
      });
    }

    if (allOk) {
      const takeUrls = state.segments.map((s) => s.videoUrl!).filter(Boolean);
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
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            outputVideoUrl: result.finalVideoUrl,
            completedAt: new Date(),
            generatedPrompt: JSON.stringify(state),
          },
        });
        return NextResponse.json({
          id: job.id,
          status: "COMPLETED",
          finalVideoUrl: result.finalVideoUrl,
          narrationDurationSeconds: state.narrationDurationSeconds,
          segments: state.segments.map((s) => ({ index: s.index, status: s.status, text: s.text })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Erro no assembly";
        state.finalErrorMessage = msg;
        await prisma.generationJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errorMessage: msg,
            completedAt: new Date(),
            generatedPrompt: JSON.stringify(state),
          },
        });
        return NextResponse.json({ id: job.id, status: "FAILED", errorMessage: msg });
      }
    }

    return NextResponse.json({ id: job.id, status: job.status });
  } catch (error) {
    console.error("[narrator/[id]] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}
