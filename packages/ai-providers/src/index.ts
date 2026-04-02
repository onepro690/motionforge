export * from "./types";
export * from "./base.provider";
export * from "./mock.provider";
export * from "./replicate.provider";
export * from "./comfyui.provider";

import { MockMotionProvider } from "./mock.provider";
import { ReplicateMotionProvider } from "./replicate.provider";
import { ComfyUIMotionProvider } from "./comfyui.provider";
import type { MotionGenerationProvider } from "./types";

export function createMotionProvider(): MotionGenerationProvider {
  const provider = process.env.AI_PROVIDER ?? "mock";
  switch (provider) {
    case "replicate":
      return new ReplicateMotionProvider();
    case "comfyui":
      return new ComfyUIMotionProvider();
    case "mock":
    default:
      return new MockMotionProvider();
  }
}
