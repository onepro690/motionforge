import fs from "fs/promises";
import path from "path";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

/**
 * Returns output dimensions based on resolution + aspect ratio config.
 * "Resolution" (480p/720p/1080p) defines the SHORT side of the video.
 */
function getDimensions(resolution: string, aspectRatio: string): { width: number; height: number } {
  const shortSide: Record<string, number> = { SD_480: 480, HD_720: 720, FHD_1080: 1080 };
  const s = shortSide[resolution] ?? 720;

  let w: number;
  let h: number;
  switch (aspectRatio) {
    case "RATIO_9_16": w = s;                       h = Math.round(s * 16 / 9); break;
    case "RATIO_1_1":  w = s;                       h = s;                       break;
    case "RATIO_4_3":  w = Math.round(s * 4 / 3);  h = s;                       break;
    case "RATIO_16_9":
    default:           w = Math.round(s * 16 / 9);  h = s;                       break;
  }

  // Ensure even numbers (required by most video codecs)
  return { width: w % 2 === 0 ? w : w + 1, height: h % 2 === 0 ? h : h + 1 };
}

/**
 * Mock provider for local development and testing.
 * Simulates a real AI pipeline with delays and respects config settings.
 * Replace with a real provider (Replicate, Kling, ComfyUI) in production.
 */
export class MockMotionProvider extends BaseMotionProvider {
  name = "mock";

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    const { resolution, aspectRatio, maxDuration, motionStrength, backgroundMode } = input.config;

    // Simulate variable processing time based on config (heavier = slower)
    const resDelay: Record<string, number> = { SD_480: 1500, HD_720: 2500, FHD_1080: 4000 };
    const bgDelay: Record<string, number> = { KEEP: 0, BLUR: 500, REMOVE: 1500, REPLACE: 2000 };
    const baseDelay = resDelay[resolution] ?? 2500;
    const extraDelay = bgDelay[backgroundMode] ?? 0;
    const motionDelay = Math.round(motionStrength * 1000);
    await this.sleep(baseDelay + extraDelay + motionDelay);

    // Ensure output directory exists
    const outputDir = path.dirname(input.outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Copy input video as "output" (mock result)
    try {
      await fs.copyFile(input.inputVideoPath, input.outputPath);
    } catch {
      await fs.writeFile(input.outputPath, "mock-video-output");
    }

    // Generate thumbnail from avatar image
    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    try {
      await fs.copyFile(input.inputImagePath, thumbnailPath);
    } catch {
      await fs.writeFile(thumbnailPath, "mock-thumbnail");
    }

    await this.sleep(1000); // Simulate final rendering step

    const { width, height } = getDimensions(resolution, aspectRatio);

    return {
      videoPath: input.outputPath,
      thumbnailPath,
      duration: maxDuration,
      width,
      height,
      fps: 24,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
