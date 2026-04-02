export interface GenerationInput {
  inputVideoPath: string;
  inputImagePath: string;
  outputPath: string;
  config: {
    aspectRatio: string;
    resolution: string;
    maxDuration: number;
    motionStrength: number;
    identityStrength: number;
    facePreserveStrength: number;
    backgroundMode: string;
  };
}

export interface GenerationOutput {
  videoPath: string;
  thumbnailPath: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface MotionGenerationProvider {
  name: string;
  generate(input: GenerationInput): Promise<GenerationOutput>;
  validateInput(
    input: GenerationInput
  ): Promise<{ valid: boolean; errors: string[] }>;
}
