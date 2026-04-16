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
  msg?: string;
  data?: {
    taskId: string;
    state: string; // "waiting" | "queuing" | "generating" | "success" | "fail"
    resultJson?: string; // JSON string: { resultUrls: string[] }
    failCode?: string;
    failMsg?: string;
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

    // Determine mode from resolution config ("std" = 720p, "pro" = 1080p)
    const mode = input.config.resolution === "FHD_1080" ? "pro" : "std";

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
      width: mode === "pro" ? 1920 : 1280,
      height: mode === "pro" ? 1080 : 720,
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

    const requestBody = {
      model: "kling-3.0/motion-control",
      input: {
        input_urls: [imageUrl],
        video_urls: [videoUrl],
        character_orientation: "video",
        background_source: backgroundSource,
      },
    };
    console.log("[Kling] Request body:", JSON.stringify(requestBody, null, 2));

    const response = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json() as { code: number; message?: string; data?: { taskId: string } };

    if (!response.ok || data.code !== 200) {
      throw new Error(`Kie.ai task creation failed: ${data.message ?? JSON.stringify(data)}`);
    }

    return { taskId: data.data!.taskId };
  }

  private async pollUntilComplete(taskId: string, timeoutSeconds: number): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const pollInterval = 10000; // 10s (kie.ai recomenda não fazer polling agressivo)

    while (Date.now() < deadline) {
      await this.sleep(pollInterval);

      // Endpoint correto: /jobs/recordInfo (não /jobs/result)
      const response = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${taskId}`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      });

      const data = await response.json() as KieResult;

      if (!response.ok) {
        console.warn(`[Kling] Poll error: ${JSON.stringify(data)}`);
        continue;
      }

      // Campo correto: state (não status)
      const state = data.data?.state;
      console.log(`[Kling] Task ${taskId} state: ${state}`);

      if (state === "success") {
        // Campo correto: resultJson é uma string JSON com { resultUrls: string[] }
        const resultJson = data.data?.resultJson;
        if (!resultJson) throw new Error("Task succeeded but resultJson is empty");

        let parsed: { resultUrls?: string[] };
        try {
          parsed = JSON.parse(resultJson);
        } catch {
          throw new Error(`Failed to parse resultJson: ${resultJson}`);
        }

        const url = parsed.resultUrls?.[0];
        if (!url) throw new Error("Task succeeded but resultUrls is empty");
        return url;
      }

      if (state === "fail") {
        throw new Error(
          `Kling task failed — code: ${data.data?.failCode ?? "?"}, msg: ${data.data?.failMsg ?? "unknown"}`
        );
      }

      // Estados intermediários: waiting / queuing / generating → continua polling
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
