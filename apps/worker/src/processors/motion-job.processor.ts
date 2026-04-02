import { Job } from "bullmq";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@motion/database";
import { createMotionProvider } from "@motion/ai-providers";
import { createStorageProvider } from "@motion/storage";
import type { MotionJobData } from "@motion/queue";
import { preprocessInputs } from "../pipeline/preprocess";
import { validateInputs } from "../pipeline/validate";

export async function processMotionJob(job: Job<MotionJobData>): Promise<void> {
  const { jobId, userId, inputVideoUrl, inputImageUrl, config } = job.data;
  const aiProvider = createMotionProvider();
  const storage = createStorageProvider();

  console.log(`[Worker] Starting job ${jobId} with provider ${aiProvider.name}`);

  const workDir = path.join(
    process.env.STORAGE_LOCAL_PATH ?? "./uploads",
    "tmp",
    jobId
  );

  try {
    // Update status to PROCESSING
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });

    await job.updateProgress(10);

    // Preprocess inputs
    console.log(`[Worker] Preprocessing inputs for job ${jobId}`);
    const preprocessed = await preprocessInputs(
      inputVideoUrl,
      inputImageUrl,
      workDir
    );

    await job.updateProgress(25);

    // Validate inputs
    console.log(`[Worker] Validating inputs for job ${jobId}`);
    const validation = await validateInputs(
      preprocessed.videoPath,
      preprocessed.imagePath,
      config.maxDuration
    );

    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join("; ")}`);
    }

    await job.updateProgress(35);

    // Update job with input metadata
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        inputVideoDuration: preprocessed.videoMetadata.duration,
        inputVideoFps: preprocessed.videoMetadata.fps,
        inputVideoWidth: preprocessed.videoMetadata.width,
        inputVideoHeight: preprocessed.videoMetadata.height,
      },
    });

    // Update status to RENDERING
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "RENDERING" },
    });

    await job.updateProgress(50);

    // Run AI inference
    console.log(`[Worker] Running AI inference for job ${jobId}`);
    const outputPath = path.join(workDir, "output.mp4");
    const result = await aiProvider.generate({
      inputVideoPath: preprocessed.videoPath,
      inputImagePath: preprocessed.imagePath,
      outputPath,
      config,
    });

    await job.updateProgress(85);

    // Upload outputs to storage
    console.log(`[Worker] Uploading outputs for job ${jobId}`);
    const videoKey = `outputs/${userId}/${jobId}/video.mp4`;
    const thumbKey = `outputs/${userId}/${jobId}/thumbnail.jpg`;

    const videoBuffer = await fs.readFile(result.videoPath);
    const videoFile = await storage.upload({
      key: videoKey,
      buffer: videoBuffer,
      mimeType: "video/mp4",
    });

    let thumbnailUrl: string | undefined;
    try {
      const thumbBuffer = await fs.readFile(result.thumbnailPath);
      const thumbFile = await storage.upload({
        key: thumbKey,
        buffer: thumbBuffer,
        mimeType: "image/jpeg",
      });
      thumbnailUrl = thumbFile.url;
    } catch {
      // thumbnail is optional
    }

    await job.updateProgress(95);

    // Mark job as completed
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        outputVideoUrl: videoFile.url,
        outputThumbnailUrl: thumbnailUrl,
        completedAt: new Date(),
      },
    });

    console.log(`[Worker] Job ${jobId} completed successfully`);
    await job.updateProgress(100);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[Worker] Job ${jobId} failed:`, errorMessage);

    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        errorMessage,
        completedAt: new Date(),
      },
    });

    throw error; // Re-throw so BullMQ marks job as failed
  } finally {
    // Cleanup work directory
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
