import path from "path";
import fs from "fs/promises";
import { Worker } from "bullmq";
import { createRedisConnection, MOTION_QUEUE_NAME } from "@motion/queue";
import { prisma } from "@motion/database";
import { createMotionProvider, SeedDanceProvider } from "@motion/ai-providers";
import { put } from "@vercel/blob";
import type { MotionJobData } from "@motion/queue";
import type { Job } from "bullmq";

// Download a file from any URL or local path to destPath
async function downloadFile(url: string, destPath: string): Promise<void> {
  // Local file path
  if (url.startsWith("/") || url.startsWith("file://")) {
    const src = url.startsWith("file://") ? url.slice(7) : url;
    try {
      await fs.copyFile(src, destPath);
      return;
    } catch {
      // fall through to HTTP
    }
  }

  // Remote URL
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
    await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return;
  }

  // Local API path like /api/uploads/...
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const res = await fetch(`${appUrl}${url}`);
  if (!res.ok) {
    // Fallback: resolve directly from local storage path
    const storagePath = process.env.STORAGE_LOCAL_PATH ?? "./uploads";
    const localPath = url.replace("/api/uploads/", storagePath + "/");
    await fs.copyFile(localPath, destPath);
    return;
  }
  await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

async function processJob(job: Job<MotionJobData>): Promise<void> {
  const { jobId, userId, inputVideoUrl, inputImageUrl, config, promptText, generatedPrompt } = job.data;
  const isTextToVideo = !!promptText;
  const workDir = path.join(
    process.env.STORAGE_LOCAL_PATH ?? "./uploads",
    "tmp",
    jobId
  );

  console.log(`[Worker] Starting job ${jobId} (mode: ${isTextToVideo ? "text-to-video/seeddance" : "motion-control"})`);

  try {
    // Mark as PROCESSING
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
    await job.updateProgress(10);

    // Download inputs
    await fs.mkdir(workDir, { recursive: true });
    const imagePath = path.join(workDir, "input_image.jpg");
    await downloadFile(inputImageUrl, imagePath);
    await job.updateProgress(25);

    // Validate image
    const errors: string[] = [];
    try {
      const is = await fs.stat(imagePath);
      if (is.size > 50 * 1024 * 1024) errors.push("Image too large (max 50MB)");
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(imagePath).toLowerCase()))
        errors.push("Invalid image format");
    } catch {
      errors.push("Image file not accessible");
    }

    if (!isTextToVideo) {
      // Motion control: also validate reference video
      const videoPath = path.join(workDir, "input_video.mp4");
      await downloadFile(inputVideoUrl!, videoPath);
      try {
        const vs = await fs.stat(videoPath);
        if (vs.size > 500 * 1024 * 1024) errors.push("Video too large (max 500MB)");
        if (![".mp4", ".mov", ".webm"].includes(path.extname(videoPath).toLowerCase()))
          errors.push("Invalid video format");
      } catch {
        errors.push("Video file not accessible");
      }
    }

    if (errors.length > 0) throw new Error(`Validation failed: ${errors.join("; ")}`);

    await job.updateProgress(35);

    // Mark as RENDERING
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "RENDERING" },
    });
    await job.updateProgress(50);

    // Run AI inference
    const outputPath = path.join(workDir, "output.mp4");
    let result: { videoPath: string; thumbnailPath: string; duration?: number; width?: number; height?: number; fps?: number };

    if (isTextToVideo) {
      // SeedDance: text + image → video
      const seeddance = new SeedDanceProvider();
      result = await seeddance.generate({
        inputImagePath: imagePath,
        outputPath,
        prompt: generatedPrompt ?? promptText!,
        aspectRatio: config.aspectRatio,
        duration: config.maxDuration,
      });
    } else {
      // Motion control: reference video → video
      const aiProvider = createMotionProvider();
      const videoPath = path.join(workDir, "input_video.mp4");
      result = await aiProvider.generate({
        inputVideoPath: videoPath,
        inputImagePath: imagePath,
        outputPath,
        config,
      });
    }
    await job.updateProgress(85);

    // Upload outputs to Vercel Blob
    const videoBuffer = await fs.readFile(result.videoPath);
    const videoBlob = await put(
      `outputs/${userId}/${jobId}/video.mp4`,
      videoBuffer,
      { access: "public", contentType: "video/mp4" }
    );

    let thumbnailUrl: string | undefined;
    try {
      const thumbBuffer = await fs.readFile(result.thumbnailPath);
      const thumbBlob = await put(
        `outputs/${userId}/${jobId}/thumbnail.jpg`,
        thumbBuffer,
        { access: "public", contentType: "image/jpeg" }
      );
      thumbnailUrl = thumbBlob.url;
    } catch {
      // thumbnail is optional
    }

    await job.updateProgress(95);

    // Mark as COMPLETED
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        outputVideoUrl: videoBlob.url,
        outputThumbnailUrl: thumbnailUrl,
        completedAt: new Date(),
      },
    });

    console.log(`[Worker] Job ${jobId} completed`);
    await job.updateProgress(100);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Worker] Job ${jobId} failed:`, errorMessage);
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "FAILED", errorMessage, completedAt: new Date() },
    });
    throw error; // Re-throw so BullMQ marks the job as failed and retries
  } finally {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

let started = false;

export function startInlineWorker(): void {
  if (started) return;
  started = true;

  try {
    const connection = createRedisConnection();
    const worker = new Worker(MOTION_QUEUE_NAME, processJob, {
      connection,
      concurrency: 2,
      limiter: { max: 5, duration: 60_000 },
    });

    worker.on("active", (job) =>
      console.log(`[Worker] Job ${job.data.jobId} active`)
    );
    worker.on("completed", (job) =>
      console.log(`[Worker] Job ${job.data.jobId} done`)
    );
    worker.on("failed", (job, err) =>
      console.error(`[Worker] Job ${job?.data.jobId} failed:`, err.message)
    );
    worker.on("error", (err) =>
      console.error("[Worker] Error:", err.message)
    );

    console.log("[Worker] Inline worker started — processing jobs automatically");
  } catch (error) {
    console.error("[Worker] Failed to start:", error);
  }
}
