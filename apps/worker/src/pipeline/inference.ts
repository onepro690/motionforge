import { createMotionProvider } from "@motion/ai-providers";
import type { GenerationInput, GenerationOutput } from "@motion/ai-providers";

export async function runInference(
  input: GenerationInput
): Promise<GenerationOutput> {
  const provider = createMotionProvider();
  console.log(`[Inference] Using provider: ${provider.name}`);

  const validation = await provider.validateInput(input);
  if (!validation.valid) {
    throw new Error(`Provider validation failed: ${validation.errors.join("; ")}`);
  }

  return provider.generate(input);
}
