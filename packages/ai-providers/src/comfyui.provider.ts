import fs from "fs/promises";
import path from "path";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

/**
 * ComfyUI provider for self-hosted AI processing.
 * Set AI_PROVIDER=comfyui and COMFYUI_URL in your .env
 */
export class ComfyUIMotionProvider extends BaseMotionProvider {
  name = "comfyui";
  private baseUrl: string;

  constructor() {
    super();
    this.baseUrl = process.env.COMFYUI_URL ?? "http://localhost:8188";
  }

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    const prompt = this.buildWorkflowPrompt(input);
    const { prompt_id } = await this.queuePrompt(prompt);
    await this.waitForCompletion(prompt_id);

    const outputPath = await this.fetchOutput(prompt_id, input.outputPath);
    const thumbnailPath = outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    await fs.copyFile(input.inputImagePath, thumbnailPath);

    return {
      videoPath: outputPath,
      thumbnailPath,
      duration: input.config.maxDuration,
      width: 1280,
      height: 720,
      fps: 24,
    };
  }

  private buildWorkflowPrompt(input: GenerationInput): object {
    return {
      "1": {
        class_type: "LoadImage",
        inputs: { image: input.inputImagePath },
      },
      "2": {
        class_type: "LoadVideo",
        inputs: { video: input.inputVideoPath },
      },
    };
  }

  private async queuePrompt(
    prompt: object
  ): Promise<{ prompt_id: string }> {
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    return response.json();
  }

  private async waitForCompletion(promptId: string): Promise<void> {
    const maxWait = 300000; // 5 minutes
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const response = await fetch(`${this.baseUrl}/history/${promptId}`);
      const history = await response.json();
      if (history[promptId]?.status?.completed) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("ComfyUI generation timed out");
  }

  private async fetchOutput(
    promptId: string,
    outputPath: string
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/history/${promptId}`);
    const history = await response.json();
    const outputs = history[promptId]?.outputs;
    if (!outputs) throw new Error("No outputs from ComfyUI");

    for (const node of Object.values(outputs) as any[]) {
      if (node.videos?.[0]) {
        const { filename, subfolder, type } = node.videos[0];
        const videoUrl = `${this.baseUrl}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
        const videoResponse = await fetch(videoUrl);
        const buffer = Buffer.from(await videoResponse.arrayBuffer());
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, buffer);
        return outputPath;
      }
    }
    throw new Error("No video output found in ComfyUI response");
  }
}
