import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const KIE_API_BASE = "https://api.kie.ai/api/v1";

/**
 * SeedDance via kie.ai — text + image → animated video.
 * The model animates an avatar based on a text prompt describing the motion.
 * Set AI_PROVIDER=seeddance, KIE_API_KEY, and optionally SEEDDANCE_MODEL_ID.
 *
 * Default model: "seeddance" — verify the exact model ID in your kie.ai dashboard
 * and set SEEDDANCE_MODEL_ID if different.
 */
export class SeedDanceProvider {
  name = "seeddance";
  private apiKey: string;
  private modelId: string;

  constructor() {
    this.apiKey = process.env.KIE_API_KEY!;
    if (!this.apiKey) throw new Error("KIE_API_KEY is required");
    this.modelId = process.env.SEEDDANCE_MODEL_ID ?? "seeddance";
  }

  async generate(input: {
    inputImagePath: string;
    outputPath: string;
    prompt: string;
    aspectRatio?: string;
    duration?: number;
  }): Promise<{ videoPath: string; thumbnailPath: string }> {
    // Upload image to Vercel Blob for public URL
    console.log("[SeedDance] Uploading image to Vercel Blob...");
    const imageBuffer = await fs.readFile(input.inputImagePath);
    const imageBlob = await put(
      `seeddance-inputs/${Date.now()}-${path.basename(input.inputImagePath)}`,
      imageBuffer,
      { access: "public", contentType: "image/jpeg" }
    );

    console.log(`[SeedDance] Creating task with model: ${this.modelId}`);
    const taskId = await this.createTask(imageBlob.url, input.prompt, input.aspectRatio, input.duration);

    console.log(`[SeedDance] Task created: ${taskId} — polling...`);
    const outputVideoUrl = await this.pollUntilComplete(taskId, 600);

    console.log(`[SeedDance] Video ready: ${outputVideoUrl}`);

    // Download output video
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
    const res = await fetch(outputVideoUrl);
    if (!res.ok) throw new Error(`Failed to download output: ${res.status}`);
    await fs.writeFile(input.outputPath, Buffer.from(await res.arrayBuffer()));

    // Use input image as thumbnail
    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    await fs.copyFile(input.inputImagePath, thumbnailPath);

    return { videoPath: input.outputPath, thumbnailPath };
  }

  private async createTask(
    imageUrl: string,
    prompt: string,
    aspectRatio = "RATIO_16_9",
    duration = 5
  ): Promise<string> {
    const body = {
      model: this.modelId,
      input: {
        input_urls: [imageUrl],
        prompt,
        duration,
        aspect_ratio: aspectRatio,
      },
    };

    console.log("[SeedDance] Request body:", JSON.stringify(body, null, 2));

    const res = await fetch(`${KIE_API_BASE}/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as {
      code: number;
      message?: string;
      data?: { taskId: string };
    };

    if (!res.ok || data.code !== 200) {
      throw new Error(`SeedDance task creation failed: ${data.message ?? JSON.stringify(data)}`);
    }

    return data.data!.taskId;
  }

  private async pollUntilComplete(taskId: string, timeoutSeconds: number): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      await this.sleep(10_000);

      const res = await fetch(`${KIE_API_BASE}/jobs/recordInfo?taskId=${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      const data = (await res.json()) as {
        code: number;
        data?: {
          state: string;
          resultJson?: string;
          failCode?: string;
          failMsg?: string;
        };
      };

      if (!res.ok) {
        console.warn(`[SeedDance] Poll error: ${JSON.stringify(data)}`);
        continue;
      }

      const state = data.data?.state;
      console.log(`[SeedDance] Task ${taskId} state: ${state}`);

      if (state === "success") {
        const resultJson = data.data?.resultJson;
        if (!resultJson) throw new Error("Task succeeded but resultJson is empty");

        const parsed = JSON.parse(resultJson) as { resultUrls?: string[] };
        const url = parsed.resultUrls?.[0];
        if (!url) throw new Error("Task succeeded but resultUrls is empty");
        return url;
      }

      if (state === "fail") {
        throw new Error(
          `SeedDance task failed — code: ${data.data?.failCode ?? "?"}, msg: ${data.data?.failMsg ?? "unknown"}`
        );
      }
    }

    throw new Error(`SeedDance task timed out after ${timeoutSeconds}s`);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
