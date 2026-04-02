import fs from "fs/promises";
import { createStorageProvider } from "@motion/storage";
import type { GenerationOutput } from "@motion/ai-providers";

export interface PostprocessResult {
  outputVideoUrl: string;
  outputThumbnailUrl?: string;
}

export async function postprocessOutputs(
  result: GenerationOutput,
  userId: string,
  jobId: string
): Promise<PostprocessResult> {
  const storage = createStorageProvider();

  const videoKey = `outputs/${userId}/${jobId}/video.mp4`;
  const thumbKey = `outputs/${userId}/${jobId}/thumbnail.jpg`;

  const videoBuffer = await fs.readFile(result.videoPath);
  const videoFile = await storage.upload({
    key: videoKey,
    buffer: videoBuffer,
    mimeType: "video/mp4",
  });

  let outputThumbnailUrl: string | undefined;
  try {
    const thumbBuffer = await fs.readFile(result.thumbnailPath);
    const thumbFile = await storage.upload({
      key: thumbKey,
      buffer: thumbBuffer,
      mimeType: "image/jpeg",
    });
    outputThumbnailUrl = thumbFile.url;
  } catch {
    // thumbnail is optional
  }

  return {
    outputVideoUrl: videoFile.url,
    outputThumbnailUrl,
  };
}
