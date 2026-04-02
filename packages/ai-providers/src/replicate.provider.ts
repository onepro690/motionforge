import Replicate from "replicate";
import https from "https";
import http from "http";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

/**
 * Replicate provider using Minimax Video-01 Live.
 * Animates the avatar image into a high-quality video.
 * Set AI_PROVIDER=replicate and REPLICATE_API_TOKEN in your .env
 */
export class ReplicateMotionProvider extends BaseMotionProvider {
  name = "replicate";
  private client: Replicate;

  constructor() {
    super();
    this.client = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
  }

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    // Upload the avatar image to Replicate as a data URI
    const { readFile } = await import("fs/promises");
    const imageBuffer = await readFile(input.inputImagePath);
    const ext = input.inputImagePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const imageDataUri = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

    const motionIntensity = input.config.motionStrength ?? 0.8;
    const prompt = this.buildPrompt(motionIntensity);

    console.log(`[Replicate] Running minimax/video-01-live...`);

    const output = await this.client.run(
      "minimax/video-01-live:7574e16b8f1ad52c6332ecb264c0f132e555f46c222255a738131ec1bb614092",
      {
        input: {
          first_frame_image: imageDataUri,
          prompt,
          prompt_optimizer: true,
        },
      }
    );

    const videoUrl = typeof output === "string" ? output : (output as { url?: string })?.url ?? String(output);

    if (!videoUrl || !videoUrl.startsWith("http")) {
      throw new Error(`Replicate returned unexpected output: ${JSON.stringify(output)}`);
    }

    console.log(`[Replicate] Video generated: ${videoUrl}`);

    const { mkdir, writeFile } = await import("fs/promises");
    const path = await import("path");
    const outputDir = path.dirname(input.outputPath);
    await mkdir(outputDir, { recursive: true });

    await this.downloadFile(videoUrl, input.outputPath);

    // Use avatar image as thumbnail
    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    await readFile(input.inputImagePath).then((buf) => writeFile(thumbnailPath, buf));

    return {
      videoPath: input.outputPath,
      thumbnailPath,
      duration: input.config.maxDuration,
      width: 1280,
      height: 720,
      fps: 24,
    };
  }

  private buildPrompt(motionStrength: number): string {
    if (motionStrength > 0.8) {
      return "Person performing expressive, dynamic movement, smooth cinematic motion, high quality";
    }
    if (motionStrength > 0.5) {
      return "Person performing natural fluid motion, smooth body movement, cinematic quality";
    }
    return "Person performing subtle gentle movement, slight natural motion, smooth transitions";
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith("https") ? https : http;
      const { createWriteStream } = require("fs");
      const file = createWriteStream(destPath);
      protocol
        .get(url, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            file.close();
            this.downloadFile(response.headers.location!, destPath).then(resolve).catch(reject);
            return;
          }
          response.pipe(file);
          file.on("finish", () => { file.close(); resolve(); });
        })
        .on("error", (err) => { file.close(); reject(err); });
    });
  }
}
