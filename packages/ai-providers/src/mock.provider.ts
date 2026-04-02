import fs from "fs/promises";
import path from "path";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

/**
 * Mock provider for local development and testing.
 * Simulates a real AI pipeline with delays.
 * Replace with a real provider (Replicate, ComfyUI) in production.
 */
export class MockMotionProvider extends BaseMotionProvider {
  name = "mock";

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    // Simulate processing delay
    await this.sleep(3000);

    // Ensure output directory exists
    const outputDir = path.dirname(input.outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // In mock mode, copy the input video as "output"
    try {
      await fs.copyFile(input.inputVideoPath, input.outputPath);
    } catch {
      // If copy fails, create a placeholder file
      await fs.writeFile(input.outputPath, "mock-video-output");
    }

    // Generate thumbnail path
    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    try {
      await fs.copyFile(input.inputImagePath, thumbnailPath);
    } catch {
      await fs.writeFile(thumbnailPath, "mock-thumbnail");
    }

    await this.sleep(2000); // Simulate rendering time

    return {
      videoPath: input.outputPath,
      thumbnailPath,
      duration: 5.0,
      width: 1280,
      height: 720,
      fps: 24,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
