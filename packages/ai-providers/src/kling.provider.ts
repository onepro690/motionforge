import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

interface KieTask {
  taskId: string;
}

interface KieResult {
  code: number;
  data?: {
    taskId: string;
    status: string;
    output?: {
      works?: Array<{ resource: string }>;
      url?: string;
    };
    video_url?: string;
    url?: string;
  };
}

/**
 * Kling 3.0 Motion Control via kie.ai
 * Transfers movement from reference video to avatar image.
 * Set AI_PROVIDER=kling and KIE_API_KEY in your .env
 */
export class KlingMotionProvider extends BaseMotionProvider {
  name = "kling";
  private apiKey: string;

  constructor() {
    super();
    this.apiKey = process.env.KIE_API_KEY!;
    if (!this.apiKey) throw new Error("KIE_API_KEY is required");
  }

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    // Upload local files to Vercel Blob to get public URLs
    console.log("[Kling] Uploading inputs to Vercel Blob...");
    const [imageUrl, videoUrl] = await Promise.all([
      this.uploadToBlob(input.inputImagePath, "image/jpeg"),
      this.uploadToBlob(input.inputVideoPath, "video/mp4"),
    ]);

    // Determine mode from resolution config
    const mode = input.config.resolution === "FHD_1080" ? "1080p" : "720p";

    console.log("[Kling] Creating motion control task...");
    const task = await this.createTask(imageUrl, videoUrl, mode, input.config.backgroundMode);

    console.log(`[Kling] Task created: ${task.taskId}`);

    // Poll until complete (up to 10 minutes)
    const outputVideoUrl = await this.pollUntilComplete(task.taskId, 600);

    console.log(`[Kling] Video ready: ${outputVideoUrl}`);

    // Download output video locally
    const outputDir = path.dirname(input.outputPath);
    await fs.mkdir(outputDir, { recursive: true });
    await this.downloadFile(outputVideoUrl, input.outputPath);

    // Use avatar image as thumbnail
    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    await fs.copyFile(input.inputImagePath, thumbnailPath);

    return {
      videoPath: input.outputPath,
      thumbnailPath,
      duration: input.config.maxDuration,
      width: mode === "1080p" ? 1920 : 1280,
      height: mode === "1080p" ? 1080 : 720,
      fps: 24,
    };
  }

  private async uploadToBlob(filePath: string, contentType: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    const blob = await put(`kling-inputs/${Date.now()}-${filename}`, buffer, {
      access: "public",
      contentType,
    });
    return blob.url;
  }

  private async createTask(
    imageUrl: string,
    videoUrl: string,
    mode: string,
    backgroundMode: string
  ): Promise<KieTask> {
    const backgroundSource = backgroundMode === "KEEP" ? "input_video" : "input_image";

    const response = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kling-3.0/motion-control",
        input: {
          input_urls: [imageUrl],
          video_urls: [videoUrl],
          mode,
          character_orientation: "video",
          background_source: backgroundSource,
        },
      }),
    });

    const data = await response.json() as { code: number; message?: string; data?: { taskId: string } };

    if (!response.ok || data.code !== 200) {
      throw new Error(`Kie.ai task creation failed: ${data.message ?? JSON.stringify(data)}`);
    }

    return { taskId: data.data!.taskId };
  }

  private async pollUntilComplete(taskId: string, timeoutSeconds: number): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const pollInterval = 5000; // 5s

    while (Date.now() < deadline) {
      await this.sleep(pollInterval);

      const response = await fetch(`${KIE_API_BASE}/jobs/result?taskId=${taskId}`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      });

      const data = await response.json() as KieResult;

      if (!response.ok) {
        console.warn(`[Kling] Poll error: ${JSON.stringify(data)}`);
        continue;
      }

      const status = data.data?.status;
      console.log(`[Kling] Task ${taskId} status: ${status}`);

      if (status === "succeed" || status === "success" || status === "completed") {
        const url =
          data.data?.output?.works?.[0]?.resource ??
          data.data?.output?.url ??
          data.data?.video_url ??
          data.data?.url;

        if (url) return url;
        throw new Error("Task completed but no output URL found");
      }

      if (status === "failed" || status === "error") {
        throw new Error(`Kling task failed: ${JSON.stringify(data.data)}`);
      }
    }

    throw new Error(`Kling task timed out after ${timeoutSeconds}s`);
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
