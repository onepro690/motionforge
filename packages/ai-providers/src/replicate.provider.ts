import Replicate from "replicate";
import fs from "fs/promises";
import path from "path";
import https from "https";
import { BaseMotionProvider } from "./base.provider";
import type { GenerationInput, GenerationOutput } from "./types";

/**
 * Replicate provider for production use.
 * Set AI_PROVIDER=replicate and REPLICATE_API_TOKEN in your .env
 */
export class ReplicateMotionProvider extends BaseMotionProvider {
  name = "replicate";
  private client: Replicate;
  private modelVersion: string;

  constructor() {
    super();
    this.client = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
    this.modelVersion =
      process.env.REPLICATE_MOTION_MODEL ??
      "stability-ai/stable-video-diffusion:3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438";
  }

  async generate(input: GenerationInput): Promise<GenerationOutput> {
    const imageBuffer = await fs.readFile(input.inputImagePath);
    const imageBase64 = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;

    const output = (await this.client.run(
      this.modelVersion as `${string}/${string}`,
      {
        input: {
          image: imageBase64,
          motion_bucket_id: Math.round(input.config.motionStrength * 255),
          fps_id: 6,
          noise_aug_strength: 1 - input.config.identityStrength,
        },
      }
    )) as string[];

    if (!output || output.length === 0) {
      throw new Error("Replicate returned no output");
    }

    const outputDir = path.dirname(input.outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    await this.downloadFile(output[0], input.outputPath);

    const thumbnailPath = input.outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
    await fs.copyFile(input.inputImagePath, thumbnailPath);

    return {
      videoPath: input.outputPath,
      thumbnailPath,
      duration: input.config.maxDuration,
      width: 1024,
      height: 576,
      fps: 6,
    };
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const file = require("fs").createWriteStream(destPath);
      https
        .get(url, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", reject);
    });
  }
}
