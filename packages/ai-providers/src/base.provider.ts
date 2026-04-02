import type { MotionGenerationProvider, GenerationInput } from "./types";

export abstract class BaseMotionProvider implements MotionGenerationProvider {
  abstract name: string;
  abstract generate(
    input: GenerationInput
  ): Promise<import("./types").GenerationOutput>;

  async validateInput(
    input: GenerationInput
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    if (!input.inputVideoPath) errors.push("Input video path is required");
    if (!input.inputImagePath) errors.push("Input image path is required");
    if (!input.outputPath) errors.push("Output path is required");
    return { valid: errors.length === 0, errors };
  }
}
